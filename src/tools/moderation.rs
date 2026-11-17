//! Moderation tools: kick/ban/timeout, purge, ban list and the audit log.

use super::messages::{BULK_DELETE_MAX_AGE_MS, delete_messages};
use super::util::{
    HistoryQuery, USER_MENTION_ID, fetch_history, guild_for_channel, plural, plural_as,
    resolve_channel,
};
use super::{Args, BulkItem, Ctx, Outcome, ToolDef};
use crate::errors::{Result, ToolError, destructive_disabled, error_text};
use crate::format::{format_member, format_user, searchable_text};
use crate::js::{clip, parse_date_ms};
use crate::json::{arr, id, s};
use crate::limiter::map_with_concurrency;
use crate::obj;
use crate::resolve::is_snowflake;
use crate::rest::{q, qo};
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

/// Discord returns at most this many bans per request.
const BAN_PAGE: usize = 1000;
/// Bounds one ban lookup to 10,000 bans.
const BAN_MAX_PAGES: usize = 10;

/// Reads the ban list page by page; bans come back sorted by user id.
async fn fetch_bans(ctx: &Ctx, guild_id: &str, after: Option<String>) -> Result<Vec<Value>> {
    let mut all = Vec::new();
    let mut cursor = after;
    for _ in 0..BAN_MAX_PAGES {
        let page = ctx
            .rest
            .get(
                &format!("/guilds/{guild_id}/bans"),
                &[("limit", q(BAN_PAGE)), ("after", qo(cursor.clone()))],
                None,
            )
            .await?;
        let page = page.as_array().cloned().unwrap_or_default();
        let n = page.len();
        let last = page
            .last()
            .and_then(|b| b.get("user"))
            .map(|u| id(u).to_string());
        all.extend(page);
        match last {
            Some(l) if n >= BAN_PAGE => cursor = Some(l),
            _ => break,
        }
    }
    Ok(all)
}

/// Kick, ban and timeout remove or silence someone, so they sit behind the destructive switch.
fn gate_moderation(action: &str, allow_destructive: bool) -> Result<()> {
    if matches!(action, "kick" | "ban" | "timeout") && !allow_destructive {
        return Err(destructive_disabled(&format!(
            "discord_moderate_member {action}"
        )));
    }
    Ok(())
}

/// Resolves the target of a moderation action. A banned user is no longer a
/// member, so unban looks the name up in the ban list instead.
async fn moderation_target(ctx: &Ctx, input: &str, guild_id: &str, action: &str) -> Result<String> {
    let trimmed = crate::js::trim(input);
    if let Some(c) = USER_MENTION_ID.captures(trimmed) {
        return Ok(c[1].to_string());
    }
    if is_snowflake(trimmed) {
        return Ok(trimmed.to_string());
    }
    // Removing or silencing the wrong person cannot be undone, so a name must match exactly.
    if action != "unban" {
        return ctx.resolver.member_id(trimmed, guild_id, true).await;
    }

    let name = trimmed.strip_prefix('@').unwrap_or(trimmed).to_lowercase();
    let bans = fetch_bans(ctx, guild_id, None).await?;
    let matches: Vec<&Value> = bans
        .iter()
        .filter(|b| {
            let user = b.get("user").cloned().unwrap_or(Value::Null);
            s(&user, "username").map(str::to_lowercase).as_deref() == Some(name.as_str())
                || s(&user, "global_name").map(str::to_lowercase).as_deref() == Some(name.as_str())
        })
        .collect();

    if matches.len() == 1 {
        return Ok(matches[0].get("user").map_or("", id).to_string());
    }
    let (message, code) = if matches.is_empty() {
        (
            format!("No banned user named \"{input}\" was found."),
            "NOT_FOUND",
        )
    } else {
        (
            format!("\"{input}\" matches several banned users."),
            "AMBIGUOUS",
        )
    };
    Err(ToolError::new(message)
        .code(code)
        .hint("Call discord_list_bans and pass the user ID.")
        .into())
}

pub fn moderate_member() -> ToolDef {
    ToolDef {
        bulk_args: &["member"],
        missing_permission_hint: Some(
            "Needs Kick Members, Ban Members or Timeout Members depending on the action, AND the bot role must sit \
             ABOVE the target member in Server Settings -> Roles. Server owners can never be moderated. \
             Banning several members at once also needs Manage Server.",
        ),
        bulk_handler: Some(moderate_bulk),
        ..ToolDef::new("discord_moderate_member", moderate_handler)
    }
}

fn moderate_bulk(
    a: Args,
    bulk_arg: String,
    members: Vec<String>,
    ctx: Ctx,
) -> BoxFuture<'static, Result<Option<Vec<BulkItem>>>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_default();
        gate_moderation(&action, ctx.config.allow_destructive)?;
        if bulk_arg != "member" || action != "ban" || members.len() < 2 {
            return Ok(None);
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let resolved = map_with_concurrency(
            members.clone(),
            ctx.config.batch_concurrency,
            |m, _| {
                let ctx = ctx.clone();
                let guild_id = guild_id.clone();
                async move { moderation_target(&ctx, &m, &guild_id, "ban").await }
            },
            false,
            None,
        )
        .await;

        let mut ids: Vec<String> = Vec::new();
        for r in resolved.iter().flatten() {
            if !ids.contains(r) {
                ids.push(r.clone());
            }
        }
        let (mut banned, mut failed): (Vec<String>, Vec<String>) = (vec![], vec![]);
        if !ids.is_empty() {
            let days = a.i64("delete_message_days").unwrap_or(0);
            let result = ctx
                .rest
                .post(
                    &format!("/guilds/{guild_id}/bulk-ban"),
                    Some(json!({ "user_ids": ids, "delete_message_seconds": days * 86400 })),
                    a.reason().as_deref(),
                    vec![],
                )
                .await?;
            banned = crate::json::strings(arr(&result, "banned_users"));
            failed = crate::json::strings(arr(&result, "failed_users"));
        }

        Ok(Some(
            members
                .iter()
                .zip(&resolved)
                .map(|(member, r)| match r {
                    Err(e) => BulkItem::err(member.as_str(), error_text(e)),
                    Ok(uid) if banned.contains(uid) => BulkItem::ok(member.as_str(), format!("Banned {member} ({uid}).")),
                    Ok(uid) => BulkItem::err(
                        member.as_str(),
                        if failed.contains(uid) {
                            "Discord refused this ban - the user may already be banned, or sit above the bot's role."
                        } else {
                            "Not banned."
                        },
                    ),
                })
                .collect(),
        ))
    })
}

fn moderate_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_default();
        gate_moderation(&action, ctx.config.allow_destructive)?;
        let duration = a.i64("duration_minutes");
        if action == "timeout" && duration.is_none() {
            return Err(
                ToolError::new("`duration_minutes` is required for a timeout.")
                    .code("MISSING_ARG")
                    .hint("For example duration_minutes: 60 mutes the member for an hour.")
                    .into(),
            );
        }

        let member = a.str("member").unwrap_or_default();
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let user_id = moderation_target(&ctx, &member, &guild_id, &action).await?;
        let reason = a.reason();

        match action.as_str() {
            "kick" => {
                ctx.rest
                    .delete(
                        &format!("/guilds/{guild_id}/members/{user_id}"),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::text(format!(
                    "Kicked {member} ({user_id}) from server {guild_id}."
                )))
            }
            "ban" => {
                let days = a.i64("delete_message_days").unwrap_or(0);
                ctx.rest
                    .put(
                        &format!("/guilds/{guild_id}/bans/{user_id}"),
                        Some(json!({ "delete_message_seconds": days * 86400 })),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::text(format!(
                    "Banned {member} ({user_id}) from server {guild_id}."
                )))
            }
            "unban" => {
                ctx.rest
                    .delete(
                        &format!("/guilds/{guild_id}/bans/{user_id}"),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::text(format!("Unbanned {member} ({user_id}).")))
            }
            _ => {
                let until = (action == "timeout").then(|| {
                    crate::js::iso_from_ms(crate::js::now_ms() + duration.unwrap_or(0) * 60_000)
                });
                let route = format!("/guilds/{guild_id}/members/{user_id}");
                let (updated, role_names) = tokio::try_join!(
                    ctx.rest.patch(
                        &route,
                        json!({ "communication_disabled_until": until.clone().map_or(Value::Null, Value::from) }),
                        reason.as_deref(),
                    ),
                    ctx.resolver.role_names(&guild_id),
                )?;
                let summary = match &until {
                    Some(u) => format!(
                        "Timed out {member} for {} minutes (until {u}).",
                        duration.unwrap_or(0)
                    ),
                    None => format!("Cleared the timeout on {member}."),
                };
                Ok(Outcome::with(
                    summary,
                    format_member(&updated, Some(&role_names)),
                ))
            }
        }
    })
}

pub fn bulk_delete() -> ToolDef {
    ToolDef {
        destructive: true,
        bulk_args: &["channel"],
        missing_permission_hint: Some(
            "Bulk deleting needs the Manage Messages permission in that channel.",
        ),
        ..ToolDef::new("discord_bulk_delete", bulk_delete_handler)
    }
}

fn timestamp_ms(m: &Value) -> f64 {
    s(m, "timestamp").map_or(f64::NAN, parse_date_ms)
}

fn bulk_delete_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild = a.str("guild");
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            guild.as_deref(),
            true,
        )
        .await?;
        let cutoff = (crate::js::now_ms() - BULK_DELETE_MAX_AGE_MS) as f64;
        let limit = a.i64("limit").unwrap_or(50).max(1) as usize;
        let from_author = a.str("from_author");

        // Nothing past 14 days is deletable in bulk, so stop paging there.
        let stop: super::util::StopFn =
            Box::new(move |page: &[Value]| page.last().map_or(f64::NAN, timestamp_ms) <= cutoff);
        let query = HistoryQuery {
            limit,
            before: a.str("before"),
            stop: Some(stop),
            ..Default::default()
        };
        let (recent, author_id) =
            tokio::try_join!(fetch_history(&ctx, &channel_id, query), async {
                match &from_author {
                    Some(author) => {
                        let g = guild_for_channel(&ctx, &channel_id, guild.as_deref()).await?;
                        ctx.resolver.member_id(author, &g, true).await.map(Some)
                    }
                    None => Ok(None),
                }
            })?;

        let needle = a.str("contains").map(|c| c.to_lowercase());
        let candidates: Vec<&Value> = recent
            .iter()
            .filter(|m| {
                author_id
                    .as_deref()
                    .is_none_or(|aid| m.get("author").map(id) == Some(aid))
                    && needle
                        .as_deref()
                        .is_none_or(|n| searchable_text(m).to_lowercase().contains(n))
            })
            .collect();

        let include_pinned = a.bool("include_pinned");
        let is_pinned = |m: &Value| m.get("pinned").and_then(Value::as_bool) == Some(true);
        let pinned = if include_pinned {
            0
        } else {
            candidates.iter().filter(|m| is_pinned(m)).count()
        };
        let eligible: Vec<&Value> = if include_pinned {
            candidates.clone()
        } else {
            candidates
                .iter()
                .filter(|m| !is_pinned(m))
                .copied()
                .collect()
        };
        let deletable: Vec<&Value> = eligible
            .iter()
            .filter(|m| timestamp_ms(m) > cutoff)
            .copied()
            .collect();
        let too_old = eligible.len() - deletable.len();

        let mut notes = Vec::new();
        if too_old > 0 {
            notes.push(format!("{too_old} older than 14 days skipped"));
        }
        if pinned > 0 {
            notes.push(format!("{pinned} pinned kept"));
        }
        let tail = if notes.is_empty() {
            String::new()
        } else {
            format!(" ({})", notes.join(", "))
        };

        if deletable.is_empty() {
            return Ok(Outcome::text(format!(
                "Nothing deleted: {} matched{tail}.",
                plural(candidates.len(), "message")
            )));
        }

        let ids: Vec<String> = deletable.iter().map(|m| id(m).to_string()).collect();
        let failures = delete_messages(&ctx, &channel_id, &ids, a.reason().as_deref()).await;
        let deleted = deletable.len() - failures.len();

        Ok(Outcome::with(
            format!(
                "Deleted {} from channel {channel_id}{tail}.",
                plural(deleted, "message")
            ),
            obj! {
                "deleted" => deleted,
                "skipped_too_old" => too_old,
                "kept_pinned" => pinned,
                "failed" => (!failures.is_empty()).then(|| Value::Array(
                    failures.iter().map(|(fid, e)| json!({ "id": fid, "error": error_text(e) })).collect()
                )),
            },
        ))
    })
}

pub fn list_bans() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some("Listing bans needs the Ban Members permission."),
        ..ToolDef::new("discord_list_bans", list_bans_handler)
    }
}

fn list_bans_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let query = a.str("query");
        let limit = a.i64("limit").unwrap_or(100).max(1) as usize;
        // A text search has to see every ban to be useful, so it pages the whole list.
        let bans = match &query {
            None => ctx
                .rest
                .get(
                    &format!("/guilds/{guild_id}/bans"),
                    &[("limit", q(limit)), ("after", qo(a.str("after")))],
                    None,
                )
                .await?
                .as_array()
                .cloned()
                .unwrap_or_default(),
            Some(_) => fetch_bans(&ctx, &guild_id, a.str("after")).await?,
        };

        let needle = query.as_ref().map(|t| t.to_lowercase());
        let shown: Vec<&Value> = bans
            .iter()
            .filter(|b| match &needle {
                None => true,
                Some(n) => {
                    let user = b.get("user").cloned().unwrap_or(Value::Null);
                    [
                        s(&user, "username").unwrap_or(""),
                        s(&user, "global_name").unwrap_or(""),
                        s(b, "reason").unwrap_or(""),
                    ]
                    .iter()
                    .any(|t| t.to_lowercase().contains(n.as_str()))
                }
            })
            .take(limit)
            .collect();

        let more = match bans.last() {
            Some(last) if needle.is_none() && bans.len() == limit => format!(
                " More bans exist: pass after={}.",
                last.get("user").map_or("", id)
            ),
            _ => String::new(),
        };

        Ok(Outcome::with(
            format!("{} in server {guild_id}.{more}", plural(shown.len(), "ban")),
            Value::Array(
                shown
                    .iter()
                    .map(|b| {
                        let user = format_user(b.get("user").unwrap_or(&Value::Null));
                        crate::json::spread(
                            &user,
                            &obj! { "reason" => b.get("reason").filter(|r| !r.is_null()).cloned() },
                        )
                    })
                    .collect(),
            ),
        ))
    })
}

/// Every audit log action type Discord defines, as (value, PascalCase name).
const AUDIT_EVENTS: &[(i64, &str)] = &[
    (1, "GuildUpdate"),
    (10, "ChannelCreate"),
    (11, "ChannelUpdate"),
    (12, "ChannelDelete"),
    (13, "ChannelOverwriteCreate"),
    (14, "ChannelOverwriteUpdate"),
    (15, "ChannelOverwriteDelete"),
    (20, "MemberKick"),
    (21, "MemberPrune"),
    (22, "MemberBanAdd"),
    (23, "MemberBanRemove"),
    (24, "MemberUpdate"),
    (25, "MemberRoleUpdate"),
    (26, "MemberMove"),
    (27, "MemberDisconnect"),
    (28, "BotAdd"),
    (30, "RoleCreate"),
    (31, "RoleUpdate"),
    (32, "RoleDelete"),
    (40, "InviteCreate"),
    (41, "InviteUpdate"),
    (42, "InviteDelete"),
    (50, "WebhookCreate"),
    (51, "WebhookUpdate"),
    (52, "WebhookDelete"),
    (60, "EmojiCreate"),
    (61, "EmojiUpdate"),
    (62, "EmojiDelete"),
    (72, "MessageDelete"),
    (73, "MessageBulkDelete"),
    (74, "MessagePin"),
    (75, "MessageUnpin"),
    (80, "IntegrationCreate"),
    (81, "IntegrationUpdate"),
    (82, "IntegrationDelete"),
    (83, "StageInstanceCreate"),
    (84, "StageInstanceUpdate"),
    (85, "StageInstanceDelete"),
    (90, "StickerCreate"),
    (91, "StickerUpdate"),
    (92, "StickerDelete"),
    (100, "GuildScheduledEventCreate"),
    (101, "GuildScheduledEventUpdate"),
    (102, "GuildScheduledEventDelete"),
    (110, "ThreadCreate"),
    (111, "ThreadUpdate"),
    (112, "ThreadDelete"),
    (121, "ApplicationCommandPermissionUpdate"),
    (130, "SoundboardSoundCreate"),
    (131, "SoundboardSoundUpdate"),
    (132, "SoundboardSoundDelete"),
    (140, "AutoModerationRuleCreate"),
    (141, "AutoModerationRuleUpdate"),
    (142, "AutoModerationRuleDelete"),
    (143, "AutoModerationBlockMessage"),
    (144, "AutoModerationFlagToChannel"),
    (145, "AutoModerationUserCommunicationDisabled"),
    (146, "AutoModerationQuarantineUser"),
    (150, "CreatorMonetizationRequestCreated"),
    (151, "CreatorMonetizationTermsAccepted"),
    (163, "OnboardingPromptCreate"),
    (164, "OnboardingPromptUpdate"),
    (165, "OnboardingPromptDelete"),
    (166, "OnboardingCreate"),
    (167, "OnboardingUpdate"),
    (190, "HomeSettingsCreate"),
    (191, "HomeSettingsUpdate"),
    (192, "VoiceChannelStatusCreate"),
    (193, "VoiceChannelStatusDelete"),
];

/// "MemberBanAdd" -> "member_ban_add": an underscore before an upper-case letter
/// that follows a lower-case letter or digit.
pub fn snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 8);
    let mut prev: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
        prev = Some(c);
    }
    out
}

fn audit_name(value: i64) -> Option<String> {
    AUDIT_EVENTS
        .iter()
        .find(|(v, _)| *v == value)
        .map(|(_, n)| snake(n))
}

fn audit_value(name: &str) -> Option<i64> {
    AUDIT_EVENTS
        .iter()
        .find(|(_, n)| snake(n) == name)
        .map(|(v, _)| *v)
}

pub fn get_audit_log() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some("Reading the audit log needs the View Audit Log permission."),
        ..ToolDef::new("discord_get_audit_log", get_audit_log_handler)
    }
}

fn get_audit_log_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let user_id = match a.str("by_member") {
            Some(m) => Some(ctx.resolver.member_id(&m, &guild_id, false).await?),
            None => None,
        };

        let log = ctx
            .rest
            .get(
                &format!("/guilds/{guild_id}/audit-logs"),
                &[
                    ("limit", q(a.i64("limit").unwrap_or(50))),
                    (
                        "action_type",
                        qo(a.str("action").and_then(|n| audit_value(&n))),
                    ),
                    ("user_id", qo(user_id)),
                    ("before", qo(a.str("before"))),
                ],
                None,
            )
            .await?;

        let users: Vec<(String, String)> = arr(&log, "users")
            .iter()
            .map(|u| {
                (
                    id(u).to_string(),
                    s(u, "username").unwrap_or("").to_string(),
                )
            })
            .collect();
        let user_name = |uid: &str| users.iter().find(|(i, _)| i == uid).map(|(_, n)| n.clone());
        let show = |v: Option<&Value>| -> Option<Value> {
            match v {
                None => None,
                Some(Value::String(t)) => Some(clip(t, 200).into()),
                Some(other) => Some(clip(&crate::js::stringify(other), 200).into()),
            }
        };
        let full = a.str("detail").as_deref() == Some("full");

        let data: Vec<Value> = arr(&log, "audit_log_entries")
            .iter()
            .map(|entry| {
                let action_type = entry.get("action_type").and_then(Value::as_i64).unwrap_or(0);
                let by = s(entry, "user_id").filter(|u| !u.is_empty()).map(|u| user_name(u).unwrap_or_else(|| u.to_string()));
                let target = entry.get("target_id").filter(|t| !t.is_null()).cloned();
                let target_user = s(entry, "target_id").filter(|t| !t.is_empty()).and_then(user_name);
                let changes = entry.get("changes").and_then(Value::as_array).map(|changes| {
                    Value::Array(
                        changes
                            .iter()
                            .map(|c| {
                                if full {
                                    let mut m = Map::new();
                                    crate::json::put(&mut m, "key", c.get("key").cloned());
                                    crate::json::put(&mut m, "old", show(c.get("old_value")));
                                    crate::json::put(&mut m, "new", show(c.get("new_value")));
                                    Value::Object(m)
                                } else {
                                    c.get("key").cloned().unwrap_or(Value::Null)
                                }
                            })
                            .collect(),
                    )
                });
                obj! {
                    "id" => entry.get("id").cloned(),
                    "action" => audit_name(action_type).unwrap_or_else(|| format!("action_{action_type}")),
                    "by" => by,
                    "target_id" => target,
                    "target_user" => target_user,
                    "reason" => entry.get("reason").filter(|r| !r.is_null()).cloned(),
                    "changes" => changes,
                }
            })
            .collect();

        Ok(Outcome::with(
            format!(
                "{} for server {guild_id}.",
                plural_as(data.len(), "audit log entry", "audit log entries")
            ),
            Value::Array(data),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_names_are_snake_case() {
        assert_eq!(snake("MemberBanAdd"), "member_ban_add");
        assert_eq!(
            snake("AutoModerationUserCommunicationDisabled"),
            "auto_moderation_user_communication_disabled"
        );
        assert_eq!(audit_value("member_ban_add"), Some(22));
        assert_eq!(
            audit_name(143).as_deref(),
            Some("auto_moderation_block_message")
        );
    }
}
