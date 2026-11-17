//! Helpers shared by the tools.

use super::Ctx;
use crate::errors::{Result, ToolError};
use crate::json::{id, s};
use crate::resolve::is_snowflake;
use crate::rest::{q, qo};
use crate::text::{EmojiRef, parse_emoji};
use regex::Regex;
use serde_json::Value;
use std::cmp::Ordering;
use std::sync::LazyLock;

/// Discord returns at most this many messages per history request.
const PAGE: usize = 100;

/// Resolves a channel reference without forcing a guild lookup when it is already an ID.
pub async fn resolve_channel(
    ctx: &Ctx,
    channel: &str,
    guild: Option<&str>,
    exact: bool,
) -> Result<String> {
    let trimmed = crate::js::trim(channel);
    if is_snowflake(trimmed) {
        return Ok(trimmed.to_string());
    }
    let guild_id = ctx.resolver.guild_id(guild).await?;
    ctx.resolver.channel_id(trimmed, &guild_id, exact).await
}

/// Resolves guild + channel together. A channel given by ID already identifies its server.
pub async fn resolve_guild_channel(
    ctx: &Ctx,
    channel: &str,
    guild: Option<&str>,
    exact: bool,
) -> Result<(String, String)> {
    let trimmed = crate::js::trim(channel);
    if guild.is_none()
        && is_snowflake(trimmed)
        && let Some(owner) = ctx.resolver.channel_guild_id(trimmed).await?
    {
        return Ok((owner, trimmed.to_string()));
    }
    let guild_id = ctx.resolver.guild_id(guild).await?;
    let channel_id = ctx.resolver.channel_id(trimmed, &guild_id, exact).await?;
    Ok((guild_id, channel_id))
}

/// The server a (resolved) channel belongs to, for looking up members or emojis there.
pub async fn guild_for_channel(ctx: &Ctx, channel_id: &str, guild: Option<&str>) -> Result<String> {
    if guild.is_some() {
        return ctx.resolver.guild_id(guild).await;
    }
    match ctx
        .resolver
        .channel_guild_id(channel_id)
        .await
        .ok()
        .flatten()
    {
        Some(owner) => Ok(owner),
        None => ctx.resolver.guild_id(None).await,
    }
}

/// Pluralises a count for summary lines: 3 -> "3 messages", 1 -> "1 message".
pub fn plural(count: usize, singular: &str) -> String {
    plural_as(count, singular, &format!("{singular}s"))
}

pub fn plural_as(count: usize, singular: &str, plural_form: &str) -> String {
    format!(
        "{count} {}",
        if count == 1 { singular } else { plural_form }
    )
}

pub type StopFn = Box<dyn Fn(&[Value]) -> bool + Send + Sync>;

#[derive(Default)]
pub struct HistoryQuery {
    pub limit: usize,
    pub before: Option<String>,
    pub after: Option<String>,
    pub around: Option<String>,
    /// Stop paging once this returns true for a fetched page.
    pub stop: Option<StopFn>,
}

/// Reads message history beyond Discord's 100-per-request cap by paging.
/// Always returns newest first, like the API.
pub async fn fetch_history(ctx: &Ctx, channel_id: &str, query: HistoryQuery) -> Result<Vec<Value>> {
    let route = format!("/channels/{channel_id}/messages");
    let cancel = Some(&ctx.cancel);

    if let Some(around) = &query.around {
        let page = ctx
            .rest
            .get(
                &route,
                &[("limit", q(query.limit.min(PAGE))), ("around", q(around))],
                cancel,
            )
            .await?;
        return Ok(page.as_array().cloned().unwrap_or_default());
    }

    let mut out: Vec<Value> = Vec::new();
    let mut before = query.before.clone();
    let mut after = query.after.clone();

    while out.len() < query.limit && !ctx.cancelled() {
        let limit = PAGE.min(query.limit - out.len());
        let page = ctx
            .rest
            .get(
                &route,
                &[
                    ("limit", q(limit)),
                    ("before", qo(before.clone())),
                    ("after", qo(after.clone())),
                ],
                cancel,
            )
            .await?;
        let page = page.as_array().cloned().unwrap_or_default();
        let n = page.len();
        let stop = query.stop.as_ref().is_some_and(|f| f(&page));
        let first = page.first().map(|m| id(m).to_string());
        let last = page.last().map(|m| id(m).to_string());
        out.extend(page);

        if n < limit || stop {
            break;
        }
        // The API answers newest first in both directions.
        if after.is_some() {
            after = first;
        } else {
            before = last;
        }
    }

    // Paging forward yields later pages that are newer than earlier ones.
    if query.after.is_some() {
        out.sort_by(|a, b| compare_snowflakes(id(b), id(a)));
    }
    Ok(out)
}

/// Orders snowflakes numerically without parsing: longer is larger, then lexical.
pub fn compare_snowflakes(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// Turns any emoji reference into the form the reactions route expects,
/// looking bare custom-emoji names up in the channel's server.
pub async fn resolve_emoji(
    ctx: &Ctx,
    emoji: &str,
    channel_id: &str,
    guild: Option<&str>,
) -> Result<String> {
    let lookup = match parse_emoji(emoji) {
        EmojiRef::Route(route) => return Ok(route),
        EmojiRef::Lookup(name) => name,
    };

    let guild_id = guild_for_channel(ctx, channel_id, guild).await?;
    let emojis = ctx.resolver.emojis(&guild_id).await?;
    let target = lookup.to_lowercase();
    let found = emojis
        .iter()
        .find(|e| s(e, "name") == Some(lookup.as_str()))
        .or_else(|| {
            emojis
                .iter()
                .find(|e| s(e, "name").map(str::to_lowercase).as_deref() == Some(target.as_str()))
        });

    match found.and_then(|e| {
        Some((
            s(e, "name").filter(|n| !n.is_empty())?,
            s(e, "id").filter(|i| !i.is_empty())?,
        ))
    }) {
        Some((name, eid)) => Ok(format!("{name}:{eid}")),
        None => {
            let names = emojis
                .iter()
                .take(30)
                .map(|e| crate::gateway::js_string(e.get("name")))
                .collect::<Vec<_>>()
                .join(", ");
            Err(
                ToolError::new(format!("No server emoji named \"{lookup}\" was found."))
                    .code("NOT_FOUND")
                    .hint(format!(
                        "Use a unicode emoji such as '✅', or one of this server's emojis: {}",
                        if names.is_empty() {
                            "(none)".to_string()
                        } else {
                            names
                        }
                    ))
                    .into(),
            )
        }
    }
}

static ROLE_MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<@&[0-9]+>$").expect("valid regex"));
static USER_MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<@!?[0-9]+>$").expect("valid regex"));
/// A user mention, capturing the ID.
pub static USER_MENTION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<@!?([0-9]{17,20})>$").expect("valid regex"));

/// Resolves the target of a permission overwrite: (id, 0 for a role / 1 for a member).
/// With 'auto' a role is tried first, then a member.
pub async fn resolve_overwrite_target(
    ctx: &Ctx,
    target: &str,
    kind: &str,
    guild_id: &str,
) -> Result<(String, i64)> {
    if kind == "role" {
        return Ok((ctx.resolver.role_id(target, guild_id, false).await?, 0));
    }
    if kind == "member" {
        return Ok((ctx.resolver.member_id(target, guild_id, false).await?, 1));
    }

    let trimmed = crate::js::trim(target);
    if ROLE_MENTION.is_match(trimmed) {
        return Ok((ctx.resolver.role_id(trimmed, guild_id, false).await?, 0));
    }
    if USER_MENTION.is_match(trimmed) {
        return Ok((ctx.resolver.member_id(trimmed, guild_id, false).await?, 1));
    }
    if is_snowflake(trimmed) {
        let is_role = trimmed == guild_id
            || ctx
                .resolver
                .roles(guild_id)
                .await?
                .iter()
                .any(|r| id(r) == trimmed);
        return Ok((trimmed.to_string(), if is_role { 0 } else { 1 }));
    }

    match ctx.resolver.role_id(target, guild_id, false).await {
        Ok(rid) => Ok((rid, 0)),
        Err(role_error) => {
            if !role_error.is("NOT_FOUND") {
                return Err(role_error);
            }
            match ctx.resolver.member_id(target, guild_id, false).await {
                Ok(uid) => Ok((uid, 1)),
                Err(_) => Err(ToolError::new(format!(
                    "\"{target}\" is neither a role nor a member of this server."
                ))
                .code("NOT_FOUND")
                .maybe_hint(role_error.tool().and_then(|t| t.hint.clone()))
                .into()),
            }
        }
    }
}
