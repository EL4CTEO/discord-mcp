//! Live event tools: wait for an event, or read the buffered ones.

use super::util::{plural, resolve_channel};
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::Result;
use crate::gateway::{BufferedEvent, Predicate, WaitResult};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;

const PRIVILEGED_NOTE: &str = "Message content and member events are unavailable: enable MESSAGE CONTENT and SERVER MEMBERS intents in the Developer Portal.";

/// Appends the privileged-intent warning whenever those events cannot arrive.
fn with_notes(summary: String, ctx: &Ctx) -> String {
    if ctx.gateway.privileged_available() {
        summary
    } else {
        format!("{summary} {PRIVILEGED_NOTE}")
    }
}

/// Builds one predicate from every filter, resolving names to IDs up front.
async fn build_matcher(ctx: &Ctx, a: &Args) -> Result<Predicate> {
    let guild = a.str("guild");
    let channel_inputs: Vec<String> = match a.get("channel") {
        None => vec![],
        Some(Value::String(c)) => vec![c.clone()],
        Some(Value::Array(list)) => crate::json::strings(list),
        Some(_) => vec![],
    };

    let (guild_id, channel_ids) = tokio::try_join!(
        async {
            match guild.as_deref().filter(|g| !g.is_empty()) {
                Some(g) => ctx.resolver.guild_id(Some(g)).await.map(Some),
                None => Ok(None),
            }
        },
        futures::future::try_join_all(channel_inputs.iter().map(|c| resolve_channel(
            ctx,
            c,
            guild.as_deref(),
            false
        ))),
    )?;

    let types: Option<Vec<String>> = a.strs("types").filter(|t| !t.is_empty());
    let channels: Option<Vec<String>> = if channel_ids.is_empty() {
        None
    } else {
        Some(channel_ids)
    };
    let needle = a.str("contains").map(|c| c.to_lowercase());
    // "@" alone would strip to "" and silently match nothing, so it counts as no filter.
    let author = a.str("from_author").map(|f| {
        let t = crate::js::trim(&f);
        t.strip_prefix('@').unwrap_or(t).to_lowercase()
    });
    let author = author.filter(|x| !x.is_empty());

    Ok(Arc::new(move |event: &BufferedEvent| {
        if types.as_ref().is_some_and(|t| !t.contains(&event.kind)) {
            return false;
        }
        if guild_id
            .as_ref()
            .is_some_and(|g| event.guild_id.as_ref() != Some(g))
        {
            return false;
        }
        if let Some(chs) = &channels
            && event.channel_id.as_ref().is_none_or(|c| !chs.contains(c))
        {
            return false;
        }
        if let Some(author) = &author
            && event.user.as_ref().map(|u| u.to_lowercase()).as_ref() != Some(author)
            && event.user_id.as_ref() != Some(author)
        {
            return false;
        }
        if let Some(needle) = &needle
            && !event
                .content
                .as_ref()
                .unwrap_or(&event.summary)
                .to_lowercase()
                .contains(needle.as_str())
        {
            return false;
        }
        true
    }))
}

pub fn wait_for_event() -> ToolDef {
    ToolDef::new("discord_wait_for_event", wait_handler)
}

fn wait_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        // Read the cursor before name resolution, which can take a while.
        let after_seq = a.i64("after_seq").map(|v| v.max(0) as u64);
        let since = after_seq.unwrap_or_else(|| ctx.gateway.last_seq());
        let matcher = build_matcher(&ctx, &a).await?;
        let timeout_seconds = a.i64("timeout_seconds").unwrap_or(60);
        let result = ctx
            .gateway
            .wait_for(
                matcher,
                (timeout_seconds.max(0) as u64) * 1000,
                Some(since),
                Some(&ctx.cancel),
            )
            .await?;
        let include_raw = a.bool("include_raw");

        if let WaitResult::Matched(event) = &result {
            let mut data = event.present(include_raw);
            data.insert("last_seq".into(), event.seq.into());
            return Ok(Outcome::with(
                with_notes(
                    format!(
                        "{}: {}",
                        event.kind,
                        crate::js::stringify(&Value::from(event.summary.clone()))
                    ),
                    &ctx,
                ),
                Value::Object(data),
            ));
        }

        let filters = format!(
            "Filters: {}.",
            a.strs("types").unwrap_or_default().join(", ")
        );
        let why = match &result {
            WaitResult::Timeout => format!("No matching event within {timeout_seconds}s"),
            WaitResult::Cancelled => "Cancelled".to_string(),
            _ => match ctx.gateway.last_error() {
                Some(e) => format!(
                    "The gateway connection closed: {}",
                    e.strip_suffix('.').unwrap_or(&e)
                ),
                None => "The gateway connection closed".to_string(),
            },
        };
        Ok(Outcome::with(
            with_notes(format!("{why}. {filters}"), &ctx),
            json!({ "timed_out": matches!(result, WaitResult::Timeout), "reason": result.reason(), "last_seq": ctx.gateway.last_seq() }),
        ))
    })
}

pub fn recent_events() -> ToolDef {
    ToolDef::new("discord_recent_events", recent_handler)
}

fn recent_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let (matcher, ()) =
            tokio::try_join!(build_matcher(&ctx, &a), ctx.gateway.ensure_connected())?;
        let after_seq = a.i64("after_seq").map(|v| v.max(0) as u64);
        let limit = a.i64("limit").unwrap_or(50).max(1) as usize;
        let buffered = ctx.gateway.recent(&matcher, after_seq, limit);

        // A full page with a cursor may hide newer matches, so the cursor moves to the page's last event.
        let page_end = if after_seq.is_some() && buffered.len() == limit {
            buffered.last()
        } else {
            None
        };
        let last_seq = page_end.map_or_else(|| ctx.gateway.last_seq(), |e| e.seq);

        let since = ctx.gateway.listening_since();
        let more = if page_end.is_some() {
            format!(" More events are buffered: call again with after_seq={last_seq}.")
        } else {
            String::new()
        };
        // The ring buffer evicts its oldest events, so a stale cursor can skip some unnoticed.
        let gap = match (after_seq, ctx.gateway.oldest_seq()) {
            (Some(after), Some(oldest)) => oldest > after + 1,
            _ => false,
        };
        let gap_note = if gap {
            format!(
                " Some events after seq {} were already dropped from the buffer.",
                after_seq.unwrap_or(0)
            )
        } else {
            String::new()
        };

        let include_raw = a.bool("include_raw");
        let mut data = serde_json::Map::new();
        data.insert(
            "events".into(),
            Value::Array(
                buffered
                    .iter()
                    .map(|e| Value::Object(e.present(include_raw)))
                    .collect(),
            ),
        );
        data.insert("last_seq".into(), last_seq.into());
        if gap {
            data.insert("gap".into(), true.into());
        }
        Ok(Outcome::with(
            with_notes(
                format!(
                    "{}{}. last_seq={last_seq}.{more}{gap_note}",
                    plural(buffered.len(), "buffered event"),
                    since
                        .map(|s| format!(" since the gateway connected at {s}"))
                        .unwrap_or_default()
                ),
                &ctx,
            ),
            Value::Object(data),
        ))
    })
}
