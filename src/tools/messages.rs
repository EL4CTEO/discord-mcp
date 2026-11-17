//! Message tools: send, DM, read, search, edit, delete, react, pin, polls.

use super::util::{
    USER_MENTION_ID, compare_snowflakes, fetch_history, guild_for_channel, plural, plural_as,
    resolve_channel, resolve_emoji,
};
use super::{Args, BulkItem, Ctx, Outcome, ToolDef};
use crate::errors::{Error, Result, ToolError, error_text};
use crate::format::{
    ANNOUNCEMENT_THREAD, Detail, GUILD_ANNOUNCEMENT, GUILD_STAGE_VOICE, GUILD_TEXT, GUILD_VOICE,
    PRIVATE_THREAD, PUBLIC_THREAD, ctype, format_message, format_poll, format_user,
    searchable_text, snowflake_ms,
};
use crate::json::{Obj, arr, id, present, s, st};
use crate::limiter::map_with_concurrency;
use crate::obj;
use crate::resolve::is_snowflake;
use crate::rest::{q, qo};
use crate::text::{MESSAGE_LIMIT, split_message};
use crate::upload::{UploadPolicy, UploadSource, load_uploads};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::collections::HashMap;

/// Channel types that actually hold readable message history.
fn is_textual(t: i64) -> bool {
    matches!(
        t,
        GUILD_TEXT
            | GUILD_ANNOUNCEMENT
            | PUBLIC_THREAD
            | PRIVATE_THREAD
            | ANNOUNCEMENT_THREAD
            | GUILD_VOICE
            | GUILD_STAGE_VOICE
    )
}

/// Discord refuses bulk deletes of anything older than this.
pub const BULK_DELETE_MAX_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// Leeway so a message that ages past 14 days mid-request is not sent to the bulk route.
const BULK_DELETE_MARGIN_MS: i64 = 60_000;
/// Long text is split into at most this many messages.
const MAX_PARTS: usize = 10;
/// Largest page Discord returns for user lists (reactions, poll voters).
const USER_PAGE: usize = 100;
/// Most users one call will list.
const USER_LIST_CAP: usize = 1000;
/// Channels scanned by a search that names none: the most recently active ones.
const SEARCH_DEFAULT_CHANNELS: usize = 50;
/// Bulk-delete failures Discord pins on one message, so retrying ids one by one can isolate it.
const PER_ID_DELETE_CODES: &[i64] = &[10008, 50034, 50035];

const SUPPRESS_EMBEDS: i64 = 1 << 2;
const SUPPRESS_NOTIFICATIONS: i64 = 1 << 12;
const FORWARD: i64 = 1;

/// The zod refinement on file inputs: exactly one of path or url.
pub fn check_files(args: &Obj, key: &str) -> Vec<(String, String)> {
    let mut issues = Vec::new();
    if let Some(files) = args.get(key).and_then(Value::as_array) {
        for (i, f) in files.iter().enumerate() {
            if f.get("path").is_some() == f.get("url").is_some() {
                issues.push((
                    format!("{key}.{i}"),
                    "Give exactly one of path or url.".to_string(),
                ));
            }
        }
    }
    issues
}

/// Discord's cap on the text of all embeds in one message, added together.
const EMBED_TOTAL_LIMIT: usize = 6000;

/// The superRefine on embed lists: the per-message total.
pub fn check_embeds(args: &Obj) -> Vec<(String, String)> {
    let Some(embeds) = args.get("embeds").and_then(Value::as_array) else {
        return vec![];
    };
    let len = |v: Option<&Value>| v.and_then(Value::as_str).map_or(0, crate::js::len16);
    let total: usize = embeds
        .iter()
        .map(|e| {
            len(e.get("title"))
                + len(e.get("description"))
                + len(e.get("footer").and_then(|f| f.get("text")))
                + len(e.get("author").and_then(|a| a.get("name")))
                + arr(e, "fields")
                    .iter()
                    .map(|f| len(f.get("name")) + len(f.get("value")))
                    .sum::<usize>()
        })
        .sum();
    if total > EMBED_TOTAL_LIMIT {
        return vec![(
            "embeds".into(),
            format!(
                "Embeds total {total} characters; Discord allows {EMBED_TOTAL_LIMIT} across all embeds of one message. \
                 Shorten them or split them across messages."
            ),
        )];
    }
    vec![]
}

fn check_post(args: &Obj) -> Vec<(String, String)> {
    let mut issues = check_embeds(args);
    issues.extend(check_files(args, "files"));
    issues
}

/// Converts the friendlier embed input into Discord's wire format.
pub fn to_api_embed(embed: &Value) -> Value {
    let mut out = embed.as_object().cloned().unwrap_or_default();
    if let Some(color) = out.get("color").cloned() {
        let n = match &color {
            Value::Number(n) => n.as_i64().unwrap_or(0),
            Value::String(s) => i64::from_str_radix(s.trim_start_matches('#'), 16).unwrap_or(0),
            _ => 0,
        };
        out.insert("color".into(), n.into());
    }
    Value::Object(out)
}

/// The allowed_mentions body: nobody is pinged unless asked, and @everyone/@here
/// also need the operator's DISCORD_ALLOW_MASS_MENTIONS.
pub fn mention_policy(allow: Option<&Value>, allow_mass: bool) -> Result<Value> {
    match allow {
        Some(Value::String(s)) if s == "everyone" => {
            if !allow_mass {
                return Err(ToolError::new("Refused: pinging @everyone or @here is disabled.")
                    .code("MASS_MENTION_DISABLED")
                    .hint("Use allow_mentions: true to ping named users and roles, or the operator can set DISCORD_ALLOW_MASS_MENTIONS=true.")
                    .into());
            }
            Ok(json!({ "parse": ["users", "roles", "everyone"], "replied_user": true }))
        }
        Some(Value::Bool(true)) => Ok(json!({ "parse": ["users", "roles"], "replied_user": true })),
        _ => Ok(json!({ "parse": [], "replied_user": false })),
    }
}

fn to_api_poll(poll: &Value) -> Value {
    json!({
        "question": { "text": s(poll, "question").unwrap_or("") },
        "answers": arr(poll, "answers").iter().map(|t| json!({ "poll_media": { "text": t } })).collect::<Vec<_>>(),
        "duration": poll.get("duration_hours").and_then(Value::as_i64).unwrap_or(24),
        "allow_multiselect": poll.get("multiselect").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn file_sources(files: &[Value]) -> Vec<UploadSource> {
    files
        .iter()
        .map(|f| UploadSource {
            path: s(f, "path").map(str::to_string),
            url: s(f, "url").map(str::to_string),
            name: s(f, "name").map(str::to_string),
            spoiler: f.get("spoiler").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect()
}

/// Posts one logical message: text over the limit is split into parts, the reply
/// reference goes on the first part, and embeds, files and polls on the last.
async fn post_message(ctx: &Ctx, channel_id: &str, a: &Args) -> Result<Vec<Value>> {
    let content = a.str("content").filter(|c| !c.is_empty());
    let embeds = a.arr("embeds").cloned().unwrap_or_default();
    let files = a.arr("files").cloned().unwrap_or_default();
    let poll = a.get("poll").cloned();
    let has_payload = !embeds.is_empty() || !files.is_empty() || poll.is_some();
    if content.is_none() && !has_payload {
        return Err(
            ToolError::new("Nothing to send: provide content, embeds, files or a poll.")
                .code("EMPTY_MESSAGE")
                .hint("Set content to the message text.")
                .into(),
        );
    }

    let suppress = a.bool("suppress_embeds");
    if suppress && !embeds.is_empty() {
        return Err(ToolError::new(
            "suppress_embeds hides every embed on the message, including the ones being sent.",
        )
        .code("CONFLICTING_ARGS")
        .hint("Drop suppress_embeds to send these embeds, or drop embeds to hide link previews.")
        .into());
    }

    let parts = content
        .as_deref()
        .map_or_else(|| vec![String::new()], |c| split_message(c, MESSAGE_LIMIT));
    if parts.len() > MAX_PARTS {
        return Err(ToolError::new(format!(
            "The text would need {} messages; the maximum is {MAX_PARTS}.",
            parts.len()
        ))
        .code("TOO_LONG")
        .hint("Shorten the text, or attach it as a file instead.")
        .into());
    }

    // Settled before any file is read or message sent, so a refused setting costs nothing.
    let allowed_mentions = mention_policy(a.get("allow_mentions"), ctx.config.allow_mass_mentions)?;
    let mut uploads = if files.is_empty() {
        Vec::new()
    } else {
        let policy = UploadPolicy {
            roots: ctx.config.upload_dirs.as_deref(),
            cancel: Some(&ctx.cancel),
            secrets: vec![ctx.config.token.clone()],
            max_bytes: None,
        };
        load_uploads(&file_sources(&files), &policy).await?
    };

    let mut flags = 0;
    if a.bool("silent") {
        flags |= SUPPRESS_NOTIFICATIONS;
    }
    if suppress {
        flags |= SUPPRESS_EMBEDS;
    }
    let reply_to = a.str("reply_to");

    let count = parts.len();
    let mut sent: Vec<Value> = Vec::new();
    for (index, part) in parts.into_iter().enumerate() {
        let first = index == 0;
        let last = index == count - 1;
        let body = obj! {
            "content" => Some(part).filter(|p| !p.is_empty()),
            "embeds" => (last && a.has("embeds")).then(|| Value::Array(embeds.iter().map(to_api_embed).collect())),
            "poll" => if last { poll.as_ref().map(to_api_poll) } else { None },
            "allowed_mentions" => allowed_mentions.clone(),
            "message_reference" => if first { reply_to.as_ref().map(|r| json!({ "message_id": r, "fail_if_not_exists": false })) } else { None },
            "flags" => (flags != 0).then_some(flags),
        };
        let files = if last {
            std::mem::take(&mut uploads)
        } else {
            vec![]
        };
        match ctx
            .rest
            .post(
                &format!("/channels/{channel_id}/messages"),
                Some(body),
                None,
                files,
            )
            .await
        {
            Ok(message) => sent.push(message),
            Err(error) => {
                // Earlier parts are already live: their ids go back with the error.
                if sent.is_empty() {
                    return Err(error);
                }
                return Err(ToolError::new(format!(
                    "Sent {} of {count} parts, then failed: {}. Sent message ids: {}.",
                    sent.len(),
                    error_text(&error),
                    sent.iter().map(id).collect::<Vec<_>>().join(", ")
                ))
                .code("PARTIAL_SEND")
                .hint("Do not resend the whole message; send only the remaining text.")
                .into());
            }
        }
    }
    Ok(sent)
}

fn sent_outcome(messages: &[Value], place: &str) -> Outcome {
    if messages.len() == 1 {
        return Outcome::with(
            format!("Sent message {} to {place}.", id(&messages[0])),
            format_message(&messages[0], Detail::Compact),
        );
    }
    Outcome::with(
        format!(
            "Sent {} messages to {place} (text was split): {}.",
            messages.len(),
            messages.iter().map(id).collect::<Vec<_>>().join(", ")
        ),
        Value::Array(
            messages
                .iter()
                .map(|m| format_message(m, Detail::Compact))
                .collect(),
        ),
    )
}

pub fn send_message() -> ToolDef {
    ToolDef {
        bulk_args: &["channel"],
        extra_check: Some(check_post),
        ..ToolDef::new("discord_send_message", send_message_handler)
    }
}

fn send_message_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild = a.str("guild");
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            guild.as_deref(),
            false,
        )
        .await?;

        if let Some(forward) = a.get("forward").cloned() {
            // Discord takes only a reference for a forward, so anything else would be dropped silently.
            let has_other = a.has("content")
                || a.arr("embeds").is_some_and(|e| !e.is_empty())
                || a.arr("files").is_some_and(|f| !f.is_empty())
                || a.has("poll")
                || a.has("reply_to");
            if has_other {
                return Err(ToolError::new(
                    "A forward carries the original message as is: content, embeds, files, poll and reply_to cannot be combined with forward.",
                )
                .code("CONFLICTING_ARGS")
                .hint("Forward on its own, then send your own text as a separate message.")
                .into());
            }

            let source_id = resolve_channel(
                &ctx,
                s(&forward, "channel").unwrap_or(""),
                guild.as_deref(),
                false,
            )
            .await?;
            let message_id = s(&forward, "message_id").unwrap_or("").to_string();
            let body = obj! {
                "message_reference" => json!({ "type": FORWARD, "message_id": message_id, "channel_id": source_id }),
                "flags" => a.bool("silent").then_some(SUPPRESS_NOTIFICATIONS),
            };
            let message = ctx
                .rest
                .post(
                    &format!("/channels/{channel_id}/messages"),
                    Some(body),
                    None,
                    vec![],
                )
                .await?;
            return Ok(Outcome::with(
                format!(
                    "Forwarded message {message_id} from channel {source_id} to channel {channel_id} as {}.",
                    id(&message)
                ),
                format_message(&message, Detail::Compact),
            ));
        }

        let messages = post_message(&ctx, &channel_id, &a).await?;
        Ok(sent_outcome(&messages, &format!("channel {channel_id}")))
    })
}

pub fn send_dm() -> ToolDef {
    ToolDef {
        bulk_args: &["user"],
        extra_check: Some(check_post),
        ..ToolDef::new("discord_send_dm", send_dm_handler)
    }
}

fn send_dm_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let user = a.str("user").unwrap_or_default();
        let trimmed = crate::js::trim(&user).to_string();
        let user_id = if let Some(c) = USER_MENTION_ID.captures(&trimmed) {
            c[1].to_string()
        } else if is_snowflake(&trimmed) {
            trimmed
        } else {
            let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
            ctx.resolver.member_id(&trimmed, &guild_id, false).await?
        };

        let channel_id = ctx.resolver.dm_channel(&user_id).await?;
        let messages = post_message(&ctx, &channel_id, &a).await?;
        Ok(sent_outcome(&messages, &format!("user {user_id} (DM)")))
    })
}

pub fn read_messages() -> ToolDef {
    ToolDef {
        bulk_args: &["channel"],
        ..ToolDef::new("discord_read_messages", read_messages_handler)
    }
}

fn read_messages_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let limit = a.i64("limit").unwrap_or(50).max(0) as usize;
        let around = a.str("around");
        let after = a.str("after");
        if around.is_some() && limit > 100 {
            return Err(ToolError::new(format!(
                "limit is {limit}, which cannot be combined with around."
            ))
            .code("INVALID_ARGS")
            .hint("around returns at most 100 messages")
            .into());
        }

        let guild = a.str("guild");
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            guild.as_deref(),
            false,
        )
        .await?;
        let from_author = a.str("from_author");
        let query = super::util::HistoryQuery {
            limit,
            before: a.str("before"),
            after: after.clone(),
            around: around.clone(),
            stop: None,
        };

        let (fetched, author_id) =
            tokio::try_join!(fetch_history(&ctx, &channel_id, query), async {
                match &from_author {
                    Some(author) => {
                        let g = guild_for_channel(&ctx, &channel_id, guild.as_deref()).await?;
                        ctx.resolver.member_id(author, &g, false).await.map(Some)
                    }
                    None => Ok(None),
                }
            })?;

        let mut messages: Vec<&Value> = match &author_id {
            None => fetched.iter().collect(),
            Some(aid) => fetched
                .iter()
                .filter(|m| m.get("author").map(id) == Some(aid.as_str()))
                .collect(),
        };
        if a.bool("oldest_first") {
            messages.reverse();
        }

        let oldest = fetched.last().map(id).filter(|o| !o.is_empty());
        let more = match oldest {
            Some(o) if fetched.len() >= limit && around.is_none() && after.is_none() => {
                format!(" Older messages exist: pass before={o}.")
            }
            _ => String::new(),
        };

        let detail = a.detail();
        Ok(Outcome::with(
            format!(
                "Read {} from channel {channel_id}.{more}",
                plural(messages.len(), "message")
            ),
            Value::Array(messages.iter().map(|m| format_message(m, detail)).collect()),
        ))
    })
}

pub fn edit_message() -> ToolDef {
    ToolDef {
        bulk_args: &["message_id"],
        extra_check: Some(check_embeds),
        ..ToolDef::new("discord_edit_message", edit_message_handler)
    }
}

fn edit_message_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        if !a.has("content") && !a.has("embeds") {
            return Err(
                ToolError::new("Nothing to change: pass content, embeds, or both.")
                    .code("MISSING_ARG")
                    .into(),
            );
        }

        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;
        let mentions = mention_policy(a.get("allow_mentions"), ctx.config.allow_mass_mentions)?;
        let body = obj! {
            "content" => a.str("content"),
            "embeds" => a.arr("embeds").map(|e| Value::Array(e.iter().map(to_api_embed).collect())),
            "allowed_mentions" => mentions,
        };
        let message = ctx
            .rest
            .patch(
                &format!(
                    "/channels/{channel_id}/messages/{}",
                    a.str("message_id").unwrap_or_default()
                ),
                body,
                None,
            )
            .await?;
        Ok(Outcome::with(
            format!("Edited message {}.", id(&message)),
            format_message(&message, Detail::Compact),
        ))
    })
}

/// True when Discord's bulk route will still accept this message.
fn bulk_deletable(message_id: &str, now: i64) -> bool {
    snowflake_ms(message_id)
        .is_some_and(|created| created > now - BULK_DELETE_MAX_AGE_MS + BULK_DELETE_MARGIN_MS)
}

fn is_per_id_failure(error: &Error) -> bool {
    error
        .api_code()
        .is_some_and(|c| PER_ID_DELETE_CODES.contains(&c))
}

/// Deletes a set of messages in as few requests as possible: one bulk request
/// per 100 recent messages, and individual deletes only for older ones (or when
/// Discord names one of a chunk's ids as the problem). Returns the failures.
pub async fn delete_messages(
    ctx: &Ctx,
    channel_id: &str,
    ids: &[String],
    reason: Option<&str>,
) -> Vec<(String, Error)> {
    let mut failures: Vec<(String, Error)> = Vec::new();
    let mut unique: Vec<String> = Vec::new();
    for i in ids {
        if !unique.contains(i) {
            unique.push(i.clone());
        }
    }
    let now = crate::js::now_ms();
    let recent: Vec<String> = unique
        .iter()
        .filter(|i| bulk_deletable(i, now))
        .cloned()
        .collect();
    let mut single: Vec<String> = unique
        .iter()
        .filter(|i| !bulk_deletable(i, now))
        .cloned()
        .collect();

    if recent.len() == 1 {
        single.extend(recent);
    } else {
        for chunk in recent.chunks(100) {
            if chunk.len() == 1 {
                single.extend(chunk.iter().cloned());
                continue;
            }
            let posted = ctx
                .rest
                .post(
                    &format!("/channels/{channel_id}/messages/bulk-delete"),
                    Some(json!({ "messages": chunk })),
                    reason,
                    vec![],
                )
                .await;
            if let Err(error) = posted {
                // A permission or rate-limit refusal would fail every retry the same way.
                if is_per_id_failure(&error) {
                    single.extend(chunk.iter().cloned());
                } else {
                    failures.extend(chunk.iter().map(|i| (i.clone(), error.clone())));
                }
            }
        }
    }

    let results = map_with_concurrency(
        single.clone(),
        ctx.config.batch_concurrency,
        |mid, _| {
            let ctx = ctx.clone();
            let route = format!("/channels/{channel_id}/messages/{mid}");
            let reason = reason.map(str::to_string);
            async move { ctx.rest.delete(&route, reason.as_deref()).await }
        },
        false,
        Some(&ctx.cancel),
    )
    .await;
    for (mid, r) in single.into_iter().zip(results) {
        if let Err(e) = r {
            failures.retain(|(f, _)| *f != mid);
            failures.push((mid, e));
        }
    }
    failures
}

pub fn delete_message() -> ToolDef {
    ToolDef {
        destructive: true,
        bulk_args: &["message_id"],
        missing_permission_hint: Some(
            "Deleting someone else's message needs the Manage Messages permission in that channel.",
        ),
        bulk_handler: Some(delete_message_bulk),
        ..ToolDef::new("discord_delete_message", delete_message_handler)
    }
}

fn delete_message_bulk(
    a: Args,
    bulk_arg: String,
    ids: Vec<String>,
    ctx: Ctx,
) -> BoxFuture<'static, Result<Option<Vec<BulkItem>>>> {
    Box::pin(async move {
        if bulk_arg != "message_id" || ids.len() < 2 {
            return Ok(None);
        }
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            true,
        )
        .await?;
        let failures = delete_messages(&ctx, &channel_id, &ids, a.reason().as_deref()).await;
        let failed: HashMap<&str, &Error> = failures.iter().map(|(i, e)| (i.as_str(), e)).collect();
        Ok(Some(
            ids.iter()
                .map(|mid| match failed.get(mid.as_str()) {
                    None => BulkItem::ok(mid.as_str(), format!("Deleted message {mid}.")),
                    Some(e) => BulkItem::err(mid.as_str(), error_text(e)),
                })
                .collect(),
        ))
    })
}

fn delete_message_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            true,
        )
        .await?;
        let mid = a.str("message_id").unwrap_or_default();
        ctx.rest
            .delete(
                &format!("/channels/{channel_id}/messages/{mid}"),
                a.reason().as_deref(),
            )
            .await?;
        Ok(Outcome::text(format!(
            "Deleted message {mid} from channel {channel_id}."
        )))
    })
}

pub fn react() -> ToolDef {
    ToolDef {
        bulk_args: &["emoji", "message_id"],
        missing_permission_hint: Some(
            "Reacting needs Add Reactions and Read Message History in that channel. A deny on @everyone applies to the \
             bot too, so grant its role Add Reactions there with discord_set_channel_permissions.",
        ),
        ..ToolDef::new("discord_react", react_handler)
    }
}

fn react_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild = a.str("guild");
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            guild.as_deref(),
            false,
        )
        .await?;
        let raw_emoji = a.str("emoji").unwrap_or_default();
        let emoji = crate::js::encode_uri_component(
            &resolve_emoji(&ctx, &raw_emoji, &channel_id, guild.as_deref()).await?,
        );
        let mid = a.str("message_id").unwrap_or_default();
        let action = a.str("action").unwrap_or_else(|| "add".into());

        if action == "list" {
            let route = format!("/channels/{channel_id}/messages/{mid}/reactions/{emoji}");
            let mut users: Vec<Value> = Vec::new();
            let mut after: Option<String> = None;
            let mut capped = false;
            loop {
                let page = ctx
                    .rest
                    .get(
                        &route,
                        &[("limit", q(USER_PAGE)), ("after", qo(after.clone()))],
                        None,
                    )
                    .await?;
                let page = page.as_array().cloned().unwrap_or_default();
                let n = page.len();
                after = page.last().map(|u| id(u).to_string());
                users.extend(page);
                if n < USER_PAGE {
                    break;
                }
                if users.len() >= USER_LIST_CAP {
                    capped = true;
                    break;
                }
            }
            let note = if capped {
                format!(" (capped at {USER_LIST_CAP}; more users may have reacted)")
            } else {
                String::new()
            };
            return Ok(Outcome::with(
                format!(
                    "{} reacted with {raw_emoji} on {mid}{note}.",
                    plural(users.len(), "user")
                ),
                Value::Array(users.iter().map(format_user).collect()),
            ));
        }

        let route = format!("/channels/{channel_id}/messages/{mid}/reactions/{emoji}/@me");
        if action == "add" {
            ctx.rest.put(&route, None, None).await?;
        } else {
            ctx.rest.delete(&route, None).await?;
        }
        Ok(Outcome::text(format!(
            "{} reaction {raw_emoji} on {mid}.",
            if action == "add" { "Added" } else { "Removed" }
        )))
    })
}

pub fn pin_message() -> ToolDef {
    ToolDef {
        bulk_args: &["message_id"],
        missing_permission_hint: Some(
            "Pinning needs the Pin Messages permission. Discord split this out of Manage Messages, so a bot \
             invited before that change will not have it - add it to the bot role under Server Settings -> Roles.",
        ),
        ..ToolDef::new("discord_pin_message", pin_message_handler)
    }
}

fn pin_message_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;
        let action = a.str("action").unwrap_or_else(|| "list".into());

        if action == "list" {
            let pins = ctx
                .rest
                .get(
                    &format!("/channels/{channel_id}/messages/pins"),
                    &[("limit", q(50))],
                    None,
                )
                .await?;
            let items = arr(&pins, "items");
            return Ok(Outcome::with(
                format!(
                    "{} in channel {channel_id}.",
                    plural(items.len(), "pinned message")
                ),
                Value::Array(
                    items
                        .iter()
                        .map(|pin| {
                            let message = pin.get("message").cloned().unwrap_or(Value::Null);
                            crate::json::spread(
                                &format_message(&message, Detail::Compact),
                                &obj! { "pinned_at" => pin.get("pinned_at").cloned() },
                            )
                        })
                        .collect(),
                ),
            ));
        }

        let Some(mid) = a.str("message_id").filter(|m| !m.is_empty()) else {
            return Err(ToolError::new(format!(
                "message_id is required when action is \"{action}\"."
            ))
            .code("MISSING_ARG")
            .hint("Call this tool with action='list' first to find the message id.")
            .into());
        };

        let route = format!("/channels/{channel_id}/messages/pins/{mid}");
        if action == "pin" {
            ctx.rest.put(&route, None, None).await?;
        } else {
            ctx.rest.delete(&route, None).await?;
        }
        Ok(Outcome::text(format!(
            "{} message {mid}.",
            if action == "pin" {
                "Pinned"
            } else {
                "Unpinned"
            }
        )))
    })
}

pub fn manage_poll() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Reading a poll needs View Channel and Read Message History in its channel. Ending one only works for polls \
             the bot posted itself: Discord refuses to end another user's poll.",
        ),
        ..ToolDef::new("discord_manage_poll", manage_poll_handler)
    }
}

fn manage_poll_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;
        let mid = a.str("message_id").unwrap_or_default();
        let action = a.str("action").unwrap_or_else(|| "results".into());

        if action == "end" {
            let message = ctx
                .rest
                .post(
                    &format!("/channels/{channel_id}/polls/{mid}/expire"),
                    None,
                    None,
                    vec![],
                )
                .await?;
            return Ok(Outcome::with(
                format!("Ended the poll on message {mid}; no more votes will count."),
                format_message(&message, Detail::Compact),
            ));
        }

        if action == "voters" {
            let Some(answer_id) = a.i64("answer_id") else {
                return Err(
                    ToolError::new("answer_id is required when action is \"voters\".")
                        .code("MISSING_ARG")
                        .hint("Call with action='results' to find the answer ids.")
                        .into(),
                );
            };
            let limit = a.i64("limit").unwrap_or(100).max(1) as usize;
            let mut voters: Vec<Value> = Vec::new();
            let mut after: Option<String> = None;
            loop {
                let want = USER_PAGE.min(limit - voters.len());
                let page = ctx
                    .rest
                    .get(
                        &format!("/channels/{channel_id}/polls/{mid}/answers/{answer_id}"),
                        &[("limit", q(want)), ("after", qo(after.clone()))],
                        None,
                    )
                    .await?;
                let users = arr(&page, "users").to_vec();
                let n = users.len();
                after = users.last().map(|u| id(u).to_string());
                voters.extend(users);
                if n < want || voters.len() >= limit {
                    break;
                }
            }
            let note = if voters.len() >= limit {
                format!(" (stopped at limit {limit}; more may exist)")
            } else {
                String::new()
            };
            return Ok(Outcome::with(
                format!(
                    "{} for answer {answer_id} on message {mid}{note}.",
                    plural(voters.len(), "voter")
                ),
                Value::Array(voters.iter().map(format_user).collect()),
            ));
        }

        let message = ctx
            .rest
            .get(&format!("/channels/{channel_id}/messages/{mid}"), &[], None)
            .await?;
        let Some(poll) = present(&message, "poll") else {
            return Err(ToolError::new(format!("Message {mid} has no poll."))
                .code("NOT_FOUND")
                .hint("Pass the ID of the message that shows the poll.")
                .into());
        };

        let poll = format_poll(poll);
        let answers = arr(&poll, "answers");
        let counted = answers.iter().any(|x| x.get("votes").is_some());
        let votes: i64 = answers
            .iter()
            .filter_map(|x| x.get("votes").and_then(Value::as_i64))
            .sum();
        let tally = if counted {
            format!("{} counted", plural(votes.max(0) as usize, "vote"))
        } else {
            "vote counts not returned".into()
        };
        let finalized = if poll.get("finalized").and_then(Value::as_bool) == Some(true) {
            ", finalized"
        } else {
            ""
        };
        Ok(Outcome::with(
            format!("Poll on message {mid}: {tally}{finalized}."),
            poll,
        ))
    })
}

fn last_message_id(channel: &Value) -> Option<String> {
    st(channel, "last_message_id").map(str::to_string)
}

/// Newest activity first; a channel that has never had a message goes last.
fn by_recent_activity(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (last_message_id(a), last_message_id(b)) {
        (Some(la), Some(lb)) => compare_snowflakes(&lb, &la),
        (la, lb) => i32::from(la.is_none()).cmp(&i32::from(lb.is_none())),
    }
}

/// The channels a search scans when none are named: the most recently active
/// text channels and threads.
async fn default_search_targets(ctx: &Ctx, guild_id: &str) -> Result<(Vec<String>, usize)> {
    let (channels, threads) = tokio::join!(
        ctx.resolver.channels(guild_id),
        ctx.resolver.threads(guild_id)
    );
    let channels = channels?;
    let threads = threads.unwrap_or_default();
    let mut textual: Vec<Value> = channels
        .iter()
        .chain(threads.iter())
        .filter(|c| is_textual(ctype(c)))
        .cloned()
        .collect();
    textual.sort_by(by_recent_activity);
    let targets: Vec<String> = textual
        .iter()
        .take(SEARCH_DEFAULT_CHANNELS)
        .map(|c| id(c).to_string())
        .collect();
    let skipped = textual.len() - targets.len();
    Ok((targets, skipped))
}

pub fn search_messages() -> ToolDef {
    ToolDef::new("discord_search_messages", search_messages_handler)
}

fn search_messages_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let channels = a.strs("channels");
        let from_author = a.str("from_author");

        let ((targets, skipped), author_id) = tokio::try_join!(
            async {
                match &channels {
                    Some(list) => {
                        let resolved = futures::future::try_join_all(
                            list.iter()
                                .map(|c| ctx.resolver.channel_id(c, &guild_id, false)),
                        )
                        .await?;
                        // "general" and its ID are the same channel; scanning it twice would double its hits.
                        let mut unique: Vec<String> = Vec::new();
                        for r in resolved {
                            if !unique.contains(&r) {
                                unique.push(r);
                            }
                        }
                        Ok((unique, 0))
                    }
                    None => default_search_targets(&ctx, &guild_id).await,
                }
            },
            async {
                match &from_author {
                    Some(author) => ctx
                        .resolver
                        .member_id(author, &guild_id, false)
                        .await
                        .map(Some),
                    None => Ok(None),
                }
            },
        )?;

        let query = a.str("query").unwrap_or_default();
        let needle = query.to_lowercase();
        let per_channel = a.i64("per_channel_limit").unwrap_or(100).max(1) as usize;

        // Every channel is its own rate-limit bucket, so scanning parallelises well.
        let scans = map_with_concurrency(
            targets.clone(),
            ctx.config.batch_concurrency.max(8),
            |channel_id, _| {
                let ctx = ctx.clone();
                let needle = needle.clone();
                let author_id = author_id.clone();
                async move {
                    let messages = fetch_history(
                        &ctx,
                        &channel_id,
                        super::util::HistoryQuery {
                            limit: per_channel,
                            ..Default::default()
                        },
                    )
                    .await?;
                    Ok(messages
                        .into_iter()
                        .filter(|m| {
                            author_id
                                .as_deref()
                                .is_none_or(|aid| m.get("author").map(id) == Some(aid))
                                && searchable_text(m).to_lowercase().contains(&needle)
                        })
                        .map(|m| (channel_id.clone(), m))
                        .collect::<Vec<_>>())
                }
            },
            false,
            Some(&ctx.cancel),
        )
        .await;

        let unreadable = scans.iter().filter(|r| r.is_err()).count();
        let mut hits: Vec<(String, Value)> = scans
            .into_iter()
            .filter_map(std::result::Result::ok)
            .flatten()
            .collect();
        hits.sort_by(|(_, a), (_, b)| compare_snowflakes(id(b), id(a)));
        let max_results = a.i64("max_results").unwrap_or(25).max(1) as usize;
        let detail = a.detail();
        let trimmed: Vec<Value> = hits
            .iter()
            .take(max_results)
            .map(|(cid, m)| {
                crate::json::spread(&json!({ "channel_id": cid }), &format_message(m, detail))
            })
            .collect();

        let unreadable_note = if unreadable > 0 {
            format!(
                " {} could not be read and were skipped.",
                plural(unreadable, "channel")
            )
        } else {
            String::new()
        };
        let unsearched_note = if skipped > 0 {
            format!(
                " {} not searched; pass channels to search them.",
                plural(skipped, "less active channel")
            )
        } else {
            String::new()
        };
        Ok(Outcome::with(
            format!(
                "Found {} for \"{query}\" across {}; showing {}.{unreadable_note}{unsearched_note}",
                plural_as(hits.len(), "match", "matches"),
                plural(targets.len(), "channel"),
                trimmed.len()
            ),
            Value::Array(trimmed),
        ))
    })
}
