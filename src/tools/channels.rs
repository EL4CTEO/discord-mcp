//! Channel tools: listing, create/edit/delete, threads, permission overwrites, reordering.

use super::util::{plural, plural_as, resolve_guild_channel, resolve_overwrite_target};
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::{Result, ToolError, error_text};
use crate::format::{
    Detail, GUILD_ANNOUNCEMENT, GUILD_CATEGORY, GUILD_FORUM, GUILD_MEDIA, GUILD_STAGE_VOICE,
    GUILD_TEXT, GUILD_VOICE, PRIVATE_THREAD, PUBLIC_THREAD, channel_type_name, ctype,
    format_channel, is_thread_type,
};
use crate::json::{arr, id, s, st};
use crate::obj;
use crate::permissions::{VIEW_CHANNEL, assert_may_grant, parse_bits, permission_names, to_bits};
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::HashSet;

/// Friendly names accepted by create/list, mapped to Discord's numeric types.
fn creatable(name: &str) -> Option<i64> {
    Some(match name {
        "text" => GUILD_TEXT,
        "voice" => GUILD_VOICE,
        "category" => GUILD_CATEGORY,
        "announcement" => GUILD_ANNOUNCEMENT,
        "stage" => GUILD_STAGE_VOICE,
        "forum" => GUILD_FORUM,
        "media" => GUILD_MEDIA,
        _ => return None,
    })
}

fn is_voice(t: i64) -> bool {
    t == GUILD_VOICE || t == GUILD_STAGE_VOICE
}

fn is_forum(t: i64) -> bool {
    t == GUILD_FORUM || t == GUILD_MEDIA
}

/// Limits for plain channels. Forum and media channels allow longer topics; stage channels allow larger user limits.
const PLAIN_TOPIC_MAX: usize = 1024;
const PLAIN_USER_LIMIT_MAX: i64 = 99;

fn position(channel: &Value) -> i64 {
    channel.get("position").and_then(Value::as_i64).unwrap_or(0)
}

fn parent_of(channel: &Value) -> Option<String> {
    st(channel, "parent_id").map(str::to_string)
}

/// Discord's own display order: position first, voice below text, IDs breaking ties.
fn display_order(a: &Value, b: &Value) -> Ordering {
    let va = i64::from(is_voice(ctype(a)));
    let vb = i64::from(is_voice(ctype(b)));
    (va - vb)
        .cmp(&0)
        .then_with(|| position(a).cmp(&position(b)))
        .then_with(|| {
            if id(a) < id(b) {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        })
}

fn sorted(mut list: Vec<Value>) -> Vec<Value> {
    list.sort_by(display_order);
    list
}

pub fn list_channels() -> ToolDef {
    ToolDef::new("discord_list_channels", list_channels_handler)
}

fn list_channels_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let include_threads = a.bool("include_threads");
        let (channels, threads) = tokio::try_join!(ctx.resolver.channels(&guild_id), async {
            if include_threads {
                ctx.resolver.threads(&guild_id).await
            } else {
                Ok(std::sync::Arc::new(vec![]))
            }
        })?;

        let categories = sorted(
            channels
                .iter()
                .filter(|c| ctype(c) == GUILD_CATEGORY)
                .cloned()
                .collect(),
        );
        let category_name = |pid: &str| {
            categories
                .iter()
                .find(|c| id(c) == pid)
                .map(|c| s(c, "name").unwrap_or("").to_string())
        };
        let threads_under = |parent: &str| -> Vec<Value> {
            threads
                .iter()
                .filter(|t| s(t, "parent_id").unwrap_or("") == parent)
                .cloned()
                .collect()
        };

        // Uncategorised channels first, then each category followed by its children.
        let children = |parent: Option<&str>| -> Vec<Value> {
            sorted(
                channels
                    .iter()
                    .filter(|c| ctype(c) != GUILD_CATEGORY && parent_of(c).as_deref() == parent)
                    .cloned()
                    .collect(),
            )
        };
        let mut ordered: Vec<Value> = Vec::new();
        let push = |ordered: &mut Vec<Value>, channel: Value| {
            let cid = id(&channel).to_string();
            ordered.push(channel);
            ordered.extend(threads_under(&cid));
        };
        for c in children(None) {
            push(&mut ordered, c);
        }
        for category in &categories {
            ordered.push(category.clone());
            for c in children(Some(id(category))) {
                push(&mut ordered, c);
            }
        }

        let kind = a.str("type").unwrap_or_else(|| "all".into());
        let wanted = if kind == "all" {
            None
        } else {
            creatable(&kind)
        };
        let detail = a.detail();
        let data: Vec<Value> = ordered
            .iter()
            .filter(|c| {
                wanted.is_none()
                    || Some(ctype(c)) == wanted
                    || (is_thread_type(ctype(c)) && include_threads)
            })
            .map(|c| {
                let base = format_channel(c, detail);
                match parent_of(c).and_then(|p| category_name(&p)) {
                    Some(category) => crate::json::spread(&base, &json!({ "category": category })),
                    None => base,
                }
            })
            .collect();

        Ok(Outcome::with(
            format!(
                "{} in server {guild_id}, in display order.",
                plural(data.len(), "channel")
            ),
            Value::Array(data),
        ))
    })
}

/// Resolves overwrite specs into Discord's wire format.
async fn to_overwrites(ctx: &Ctx, guild_id: &str, specs: &[Value]) -> Result<Vec<Value>> {
    let work = specs.iter().map(|spec| async move {
        let target = s(spec, "target").unwrap_or("").to_string();
        let allow = to_bits(&crate::json::strings(arr(spec, "allow")));
        let deny = to_bits(&crate::json::strings(arr(spec, "deny")));
        // Same gate as discord_set_channel_permissions, or this path would be the way around it.
        assert_may_grant(allow, ctx.config.allow_destructive, &format!("{target} on the new channel"))?;
        let (tid, ttype) = resolve_overwrite_target(ctx, &target, s(spec, "target_type").unwrap_or("auto"), guild_id).await?;
        Ok(json!({ "id": tid, "type": ttype, "allow": allow.to_string(), "deny": deny.to_string() }))
    });
    futures::future::try_join_all(work).await
}

pub fn create_channel() -> ToolDef {
    ToolDef {
        bulk_args: &["name"],
        missing_permission_hint: Some(
            "Needs Manage Channels; setting permissions also needs Manage Roles, and the bot can only grant permissions it holds.",
        ),
        ..ToolDef::new("discord_create_channel", create_channel_handler)
    }
}

fn create_channel_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let type_name = a.str("type").unwrap_or_else(|| "text".into());
        let kind = creatable(&type_name).unwrap_or(GUILD_TEXT);
        let topic = a.str("topic");
        if topic
            .as_deref()
            .is_some_and(|t| crate::js::len16(t) > PLAIN_TOPIC_MAX)
            && !is_forum(kind)
        {
            return Err(ToolError::new(format!(
                "A {type_name} channel's topic is limited to {PLAIN_TOPIC_MAX} characters."
            ))
            .code("INVALID_ARGS")
            .hint("Shorten the topic, or create a forum or media channel, which allow 4096.")
            .into());
        }
        if a.i64("user_limit")
            .is_some_and(|l| l > PLAIN_USER_LIMIT_MAX)
            && kind != GUILD_STAGE_VOICE
        {
            return Err(ToolError::new(format!(
                "A {type_name} channel's user limit is capped at {PLAIN_USER_LIMIT_MAX}."
            ))
            .code("INVALID_ARGS")
            .hint("Use a limit of 99 or less, or create a stage channel, which allows up to 10000.")
            .into());
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let category = a.str("category").filter(|c| !c.is_empty());
        let specs = a.arr("permissions").cloned();
        let (parent_id, overwrites) = tokio::try_join!(
            async {
                match &category {
                    Some(c) => ctx.resolver.channel_id(c, &guild_id, false).await.map(Some),
                    None => Ok(None),
                }
            },
            async {
                match &specs {
                    Some(sp) => to_overwrites(&ctx, &guild_id, sp).await.map(Some),
                    None => Ok(None),
                }
            },
        )?;

        // Discord only copies category permissions when none are given, so an
        // explicit list is layered on top of the category's own overwrites.
        let mut permission_overwrites = overwrites.clone();
        if let (Some(ow), Some(pid)) = (&overwrites, &parent_id) {
            // Read fresh: a stale copy could carry a category's old, public overwrites into a private channel.
            let parent = ctx.rest.get(&format!("/channels/{pid}"), &[], None).await?;
            let explicit: HashSet<&str> = ow.iter().map(id).collect();
            let mut merged: Vec<Value> = arr(&parent, "permission_overwrites")
                .iter()
                .filter(|o| !explicit.contains(id(o)))
                .cloned()
                .collect();
            merged.extend(ow.iter().cloned());
            permission_overwrites = Some(merged);
        }

        let body = obj! {
            "name" => a.str("name"),
            "type" => kind,
            "parent_id" => parent_id,
            "topic" => topic,
            "nsfw" => a.opt_bool("nsfw"),
            "rate_limit_per_user" => a.i64("slowmode_seconds"),
            "user_limit" => a.i64("user_limit"),
            "position" => a.i64("position"),
            "permission_overwrites" => permission_overwrites,
        };
        let channel = ctx
            .rest
            .post(
                &format!("/guilds/{guild_id}/channels"),
                Some(body),
                a.reason().as_deref(),
                vec![],
            )
            .await?;

        ctx.resolver.upsert_channel(&guild_id, &channel);
        Ok(Outcome::with(
            format!(
                "Created {type_name} channel \"{}\" ({}).",
                a.str("name").unwrap_or_default(),
                id(&channel)
            ),
            format_channel(&channel, Detail::Compact),
        ))
    })
}

pub fn edit_channel() -> ToolDef {
    ToolDef {
        bulk_args: &["channel"],
        missing_permission_hint: Some("Needs the Manage Channels permission on that channel."),
        ..ToolDef::new("discord_edit_channel", edit_channel_handler)
    }
}

fn overwrites_of(channel: Option<&Value>) -> Vec<Value> {
    channel
        .map(|c| arr(c, "permission_overwrites").to_vec())
        .unwrap_or_default()
}

fn bits(o: &Value, key: &str) -> u128 {
    s(o, key).and_then(parse_bits).unwrap_or(0)
}

/// True when some overwrite on the channel denies View Channel, i.e. it is private to someone.
fn hides_from_someone(channel: Option<&Value>) -> bool {
    overwrites_of(channel)
        .iter()
        .any(|o| bits(o, "deny") & u128::from(VIEW_CHANNEL) != 0)
}

fn edit_channel_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let changes = [
            "name",
            "topic",
            "nsfw",
            "slowmode_seconds",
            "user_limit",
            "position",
            "category",
            "sync_permissions",
        ];
        if !changes.iter().any(|k| a.has(k)) {
            return Err(
                ToolError::new("Nothing to change: pass at least one field to update.")
                    .code("MISSING_ARG")
                    .into(),
            );
        }
        if a.has("sync_permissions") && !a.has("category") {
            return Err(ToolError::new(
                "`sync_permissions` only applies when moving the channel with `category`.",
            )
            .code("MISSING_ARG")
            .hint("Pass `category` alongside sync_permissions, or drop sync_permissions.")
            .into());
        }

        let (guild_id, channel_id) = resolve_guild_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;

        // Only a channel the cache knows can be judged here; anything unknown is left to Discord.
        let topic = a.str("topic");
        let user_limit = a.i64("user_limit");
        let topic_len = topic.as_deref().map_or(0, crate::js::len16);
        let needs_large =
            topic_len > PLAIN_TOPIC_MAX || user_limit.unwrap_or(0) > PLAIN_USER_LIMIT_MAX;
        let known = if needs_large {
            ctx.resolver.find_channel(&guild_id, &channel_id).await?
        } else {
            None
        };
        let plain_topic = known.as_ref().is_some_and(|k| !is_forum(ctype(k)));
        let plain_limit = known
            .as_ref()
            .is_some_and(|k| ctype(k) != GUILD_STAGE_VOICE);
        if plain_topic && topic.is_some() && topic_len > PLAIN_TOPIC_MAX {
            return Err(ToolError::new(format!(
                "This channel's topic is limited to {PLAIN_TOPIC_MAX} characters."
            ))
            .code("INVALID_ARGS")
            .hint("Shorten the topic. Only forum and media channels allow 4096.")
            .into());
        }
        if plain_limit && user_limit.is_some_and(|l| l > PLAIN_USER_LIMIT_MAX) {
            return Err(ToolError::new(format!(
                "This channel's user limit is capped at {PLAIN_USER_LIMIT_MAX}."
            ))
            .code("INVALID_ARGS")
            .hint("Use a limit of 99 or less. Only stage channels allow up to 10000.")
            .into());
        }

        // None: not moving. Some(None): move to the top level. Some(Some(id)): move under a category.
        let parent_id: Option<Option<String>> = match a.get("category") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(Some(
                ctx.resolver
                    .channel_id(v.as_str().unwrap_or(""), &guild_id, false)
                    .await?,
            )),
        };

        // Discord's channel PATCH has no lock_permissions field; syncing only happens on the positions route.
        let sync_move = a.opt_bool("sync_permissions") == Some(true) && parent_id.is_some();
        let reason = a.reason();
        if sync_move && !ctx.config.allow_destructive {
            let current = ctx
                .rest
                .get(&format!("/channels/{channel_id}"), &[], None)
                .await?;
            if hides_from_someone(Some(&current)) {
                return Err(ToolError::new("Refused: syncing would replace this private channel's overwrites and could expose it.")
                    .code("EXPOSES_CHANNEL")
                    .hint("Move it without sync_permissions to keep its overwrites, or the operator can set DISCORD_ALLOW_DESTRUCTIVE=true.")
                    .into());
            }
            // Syncing copies the category's grants onto this channel, which is a grant in itself.
            if let Some(Some(pid)) = &parent_id {
                let parent = ctx.rest.get(&format!("/channels/{pid}"), &[], None).await?;
                let own: Vec<(String, u128)> = overwrites_of(Some(&current))
                    .iter()
                    .map(|o| (id(o).to_string(), bits(o, "allow")))
                    .collect();
                for o in overwrites_of(Some(&parent)) {
                    let had = own
                        .iter()
                        .find(|(oid, _)| oid == id(&o))
                        .map_or(0, |(_, b)| *b);
                    assert_may_grant(
                        bits(&o, "allow") & !had,
                        false,
                        &format!("overwrite {} copied from the category", id(&o)),
                    )?;
                }
            }
        }
        if sync_move {
            let pid = parent_id.clone().flatten().map_or(Value::Null, Value::from);
            ctx.rest
                .patch(
                    &format!("/guilds/{guild_id}/channels"),
                    json!([{ "id": channel_id, "parent_id": pid, "lock_permissions": true }]),
                    reason.as_deref(),
                )
                .await?;
        }

        let parent_field: Option<Value> = if sync_move {
            None
        } else {
            parent_id
                .clone()
                .map(|p| p.map_or(Value::Null, Value::from))
        };
        let body = obj! {
            "name" => a.str("name"),
            "topic" => topic,
            "nsfw" => a.opt_bool("nsfw"),
            "rate_limit_per_user" => a.i64("slowmode_seconds"),
            "user_limit" => user_limit,
            "position" => a.i64("position"),
            "parent_id" => parent_field,
        };
        let has_changes = body.as_object().is_some_and(|m| !m.is_empty());
        // The positions route returns nothing, so a sync move without other edits refetches the channel.
        let channel = if has_changes {
            ctx.rest
                .patch(&format!("/channels/{channel_id}"), body, reason.as_deref())
                .await?
        } else {
            ctx.rest
                .get(&format!("/channels/{channel_id}"), &[], None)
                .await?
        };

        if sync_move {
            ctx.resolver.invalidate_channels(&guild_id);
        } else {
            ctx.resolver.upsert_channel(&guild_id, &channel);
        }
        Ok(Outcome::with(
            format!("Updated channel {channel_id}."),
            format_channel(&channel, Detail::Full),
        ))
    })
}

pub fn delete_channel() -> ToolDef {
    ToolDef {
        destructive: true,
        bulk_args: &["channel"],
        missing_permission_hint: Some(
            "Needs the Manage Channels permission (Manage Threads for threads).",
        ),
        ..ToolDef::new("discord_delete_channel", delete_channel_handler)
    }
}

fn delete_channel_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let (guild_id, channel_id) = resolve_guild_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            true,
        )
        .await?;
        let deleted = ctx
            .rest
            .delete(&format!("/channels/{channel_id}"), a.reason().as_deref())
            .await?;

        // Children of a deleted category move to the top level, so their cached parent ids are stale.
        if ctype(&deleted) == GUILD_CATEGORY {
            ctx.resolver.invalidate_channels(&guild_id);
        } else {
            ctx.resolver.remove_channel(&guild_id, &channel_id);
        }
        let name = st(&deleted, "name").unwrap_or(&channel_id).to_string();
        Ok(Outcome::text(format!(
            "Deleted {} channel \"{name}\".",
            channel_type_name(ctype(&deleted))
        )))
    })
}

pub fn manage_thread() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Needs Create Public/Private Threads (Send Messages for forum posts) to create, or Manage Threads to \
             archive, lock or unlock.",
        ),
        ..ToolDef::new("discord_manage_thread", manage_thread_handler)
    }
}

fn manage_thread_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_default();
        let guild = a.str("guild");
        let channel = a.str("channel").filter(|c| !c.is_empty());

        if action == "list" {
            let guild_id = ctx.resolver.guild_id(guild.as_deref()).await?;
            let (threads, parent_id) = tokio::try_join!(ctx.resolver.threads(&guild_id), async {
                match &channel {
                    Some(c) => ctx.resolver.channel_id(c, &guild_id, false).await.map(Some),
                    None => Ok(None),
                }
            })?;
            let shown: Vec<Value> = match &parent_id {
                None => threads.to_vec(),
                Some(p) => threads
                    .iter()
                    .filter(|t| s(t, "parent_id") == Some(p.as_str()))
                    .cloned()
                    .collect(),
            };
            let place = parent_id
                .as_ref()
                .map_or_else(|| format!("server {guild_id}"), |p| format!("channel {p}"));
            return Ok(Outcome::with(
                format!("{} in {place}.", plural(shown.len(), "active thread")),
                Value::Array(
                    shown
                        .iter()
                        .map(|t| format_channel(t, Detail::Compact))
                        .collect(),
                ),
            ));
        }

        let Some(channel) = channel else {
            return Err(ToolError::new("`channel` is required for this action.")
                .code("MISSING_ARG")
                .hint(
                    "For create pass the parent channel; for state changes pass the thread itself.",
                )
                .into());
        };

        if action == "create" {
            let Some(name) = a.str("name").filter(|n| !n.is_empty()) else {
                return Err(ToolError::new("`name` is required when creating a thread.")
                    .code("MISSING_ARG")
                    .into());
            };

            let (guild_id, channel_id) =
                resolve_guild_channel(&ctx, &channel, guild.as_deref(), false).await?;
            let parent = ctx.resolver.find_channel(&guild_id, &channel_id).await?;
            let forum = parent.as_ref().is_some_and(|p| is_forum(ctype(p)));
            let content = a.str("content").filter(|c| !c.is_empty());

            if forum && content.is_none() {
                return Err(ToolError::new("A forum post needs a first message.")
                    .code("MISSING_ARG")
                    .hint("Pass `content` with the text of the post.")
                    .into());
            }

            let message_id = a.str("message_id").filter(|m| !m.is_empty());
            let route = match (&message_id, forum) {
                (Some(mid), false) => format!("/channels/{channel_id}/messages/{mid}/threads"),
                _ => format!("/channels/{channel_id}/threads"),
            };
            let mut body = Map::new();
            body.insert("name".into(), name.clone().into());
            body.insert(
                "auto_archive_duration".into(),
                a.i64("auto_archive_minutes").unwrap_or(1440).into(),
            );
            if forum {
                body.insert("message".into(), obj! { "content" => content.clone(), "allowed_mentions" => json!({ "parse": [] }) });
            } else if message_id.is_none() {
                body.insert(
                    "type".into(),
                    (if a.bool("private") {
                        PRIVATE_THREAD
                    } else {
                        PUBLIC_THREAD
                    })
                    .into(),
                );
            }
            let thread = ctx
                .rest
                .post(
                    &route,
                    Some(Value::Object(body)),
                    a.reason().as_deref(),
                    vec![],
                )
                .await?;
            ctx.resolver.invalidate_threads(&guild_id);
            let thread_id = id(&thread).to_string();

            // Text-channel threads start empty; post the opening message into them. The
            // thread already exists, so a failed post is reported rather than thrown.
            if !forum && let Some(text) = &content {
                let posted = ctx
                    .rest
                    .post(
                        &format!("/channels/{thread_id}/messages"),
                        Some(json!({ "content": text, "allowed_mentions": { "parse": [] } })),
                        None,
                        vec![],
                    )
                    .await;
                if let Err(e) = posted {
                    return Ok(Outcome::with(
                        format!(
                            "Created thread \"{name}\" ({thread_id}), but posting the first message failed: {}",
                            error_text(&e)
                        ),
                        format_channel(&thread, Detail::Compact),
                    ));
                }
            }

            return Ok(Outcome::with(
                format!(
                    "Created {} \"{name}\" ({thread_id}).",
                    if forum { "forum post" } else { "thread" }
                ),
                format_channel(&thread, Detail::Compact),
            ));
        }

        let (guild_id, channel_id) =
            resolve_guild_channel(&ctx, &channel, guild.as_deref(), false).await?;
        let state = match action.as_str() {
            "archive" => json!({ "archived": true }),
            "unarchive" => json!({ "archived": false }),
            "lock" => json!({ "locked": true }),
            _ => json!({ "locked": false }),
        };
        let thread = ctx
            .rest
            .patch(
                &format!("/channels/{channel_id}"),
                state,
                a.reason().as_deref(),
            )
            .await?;
        ctx.resolver.invalidate_threads(&guild_id);
        Ok(Outcome::with(
            format!("Thread {channel_id}: {action} applied."),
            format_channel(&thread, Detail::Compact),
        ))
    })
}

pub fn set_channel_permissions() -> ToolDef {
    ToolDef {
        bulk_args: &["channel", "target"],
        missing_permission_hint: Some(
            "Editing channel permissions needs Manage Roles, and a bot can only grant permissions it holds itself.",
        ),
        ..ToolDef::new(
            "discord_set_channel_permissions",
            set_channel_permissions_handler,
        )
    }
}

fn set_channel_permissions_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let mode = a.str("mode").unwrap_or_else(|| "merge".into());
        let allow = a.strs("allow");
        let deny = a.strs("deny");
        let allow_list = allow.clone().unwrap_or_default();
        let deny_list = deny.clone().unwrap_or_default();
        if mode != "reset" && allow_list.is_empty() && deny_list.is_empty() {
            return Err(ToolError::new("Nothing to apply: pass at least one permission in `allow` or `deny`.")
                .code("MISSING_ARG")
                .hint("For a read-only channel try deny: ['SendMessages','AddReactions','CreatePublicThreads'], or mode 'reset'.")
                .into());
        }

        let overlap: Vec<&String> = allow_list
            .iter()
            .filter(|p| deny_list.contains(p))
            .collect();
        if !overlap.is_empty() {
            return Err(ToolError::new(format!(
                "These permissions are in both allow and deny: {}.",
                overlap
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
            .code("CONFLICTING_ARGS")
            .hint("A permission can be allowed or denied, not both. Remove it from one list.")
            .into());
        }

        let target = a.str("target").unwrap_or_default();
        let (guild_id, channel_id) = resolve_guild_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;
        let (target_id, target_type) = resolve_overwrite_target(
            &ctx,
            &target,
            &a.str("target_type").unwrap_or_else(|| "auto".into()),
            &guild_id,
        )
        .await?;
        let route = format!("/channels/{channel_id}/permissions/{target_id}");

        let channel = ctx
            .rest
            .get(&format!("/channels/{channel_id}"), &[], None)
            .await?;
        let existing = arr(&channel, "permission_overwrites")
            .iter()
            .find(|o| id(o) == target_id)
            .cloned();

        // Bitfields are merged whole, so bits the curated list does not name survive a merge.
        let mut allow_bits = to_bits(&allow_list);
        let mut deny_bits = to_bits(&deny_list);
        if mode == "reset" {
            allow_bits = 0;
            deny_bits = 0;
        } else if mode == "merge"
            && let Some(e) = &existing
        {
            // Anything newly allowed stops being denied, and vice versa.
            allow_bits |= bits(e, "allow") & !deny_bits;
            deny_bits |= bits(e, "deny") & !allow_bits;
        }

        let already_allowed = existing.as_ref().map_or(0, |e| bits(e, "allow"));
        assert_may_grant(
            allow_bits & !already_allowed,
            ctx.config.allow_destructive,
            &format!("{target} on this channel"),
        )?;
        let was_hidden = existing
            .as_ref()
            .is_some_and(|e| bits(e, "deny") & u128::from(VIEW_CHANNEL) != 0);
        if was_hidden && deny_bits & u128::from(VIEW_CHANNEL) == 0 && !ctx.config.allow_destructive
        {
            return Err(ToolError::new(format!("Refused: this would let {target} see a channel currently hidden from them."))
                .code("EXPOSES_CHANNEL")
                .hint(
                    "Exposing a private channel is gated like other destructive actions. The operator can set \
                     DISCORD_ALLOW_DESTRUCTIVE=true, or change it by hand in the channel settings.",
                )
                .into());
        }

        // The channel was just read fresh, so the change folds into the cache instead of forcing a relisting.
        let others: Vec<Value> = arr(&channel, "permission_overwrites")
            .iter()
            .filter(|o| id(o) != target_id)
            .cloned()
            .collect();
        let reason = a.reason();

        if mode == "reset" {
            ctx.rest.delete(&route, reason.as_deref()).await?;
            let updated =
                crate::json::spread(&channel, &json!({ "permission_overwrites": others }));
            ctx.resolver.upsert_channel(&guild_id, &updated);
            return Ok(Outcome::with(
                format!(
                    "Removed the overwrite for {target} on channel {channel_id}; it now inherits."
                ),
                json!({ "channel_id": channel_id, "target": target, "target_id": target_id, "allow": [], "deny": [] }),
            ));
        }

        ctx.rest
            .put(&route, Some(json!({ "type": target_type, "allow": allow_bits.to_string(), "deny": deny_bits.to_string() })), reason.as_deref())
            .await?;
        let overwrite = json!({ "id": target_id, "type": target_type, "allow": allow_bits.to_string(), "deny": deny_bits.to_string() });
        let mut all = others;
        all.push(overwrite);
        ctx.resolver.upsert_channel(
            &guild_id,
            &crate::json::spread(&channel, &json!({ "permission_overwrites": all })),
        );

        let mut parts = Vec::new();
        if !allow_list.is_empty() {
            parts.push(format!("allowed {}", allow_list.join(", ")));
        }
        if !deny_list.is_empty() {
            parts.push(format!("denied {}", deny_list.join(", ")));
        }
        Ok(Outcome::with(
            format!("On channel {channel_id}, {target}: {}.", parts.join("; ")),
            json!({
                "channel_id": channel_id,
                "target": target,
                "target_id": target_id,
                "allow": permission_names(allow_bits),
                "deny": permission_names(deny_bits),
            }),
        ))
    })
}

pub fn reorder_channels() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some("Needs the Manage Channels permission."),
        ..ToolDef::new("discord_reorder_channels", reorder_channels_handler)
    }
}

fn reorder_channels_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let order = a.strs("order").unwrap_or_default();
        let (ids, channels) = tokio::try_join!(
            futures::future::try_join_all(
                order
                    .iter()
                    .map(|c| ctx.resolver.channel_id(c, &guild_id, false))
            ),
            ctx.resolver.channels(&guild_id),
        )?;

        if let Some(dup) = ids
            .iter()
            .enumerate()
            .find(|(i, x)| ids.iter().position(|y| y == *x) != Some(*i))
            .map(|(_, x)| x)
        {
            return Err(
                ToolError::new(format!("Channel {dup} appears more than once in order."))
                    .code("DUPLICATE_CHANNEL")
                    .hint("List each channel exactly once.")
                    .into(),
            );
        }

        let by_id = |cid: &str| channels.iter().find(|c| id(c) == cid);
        let chosen: Vec<Option<&Value>> = ids.iter().map(|i| by_id(i)).collect();
        let missing: Vec<&str> = ids
            .iter()
            .zip(&chosen)
            .filter(|(_, c)| c.is_none())
            .map(|(i, _)| i.as_str())
            .collect();
        if !missing.is_empty() {
            return Err(ToolError::new(format!(
                "Not top-level channels of this server: {}.",
                missing.join(", ")
            ))
            .code("NOT_FOUND")
            .hint("Threads cannot be reordered. Call discord_list_channels for valid channels.")
            .into());
        }

        let is_category = |c: &Value| ctype(c) == GUILD_CATEGORY;
        let categories = chosen.iter().flatten().filter(|c| is_category(c)).count();
        let mut parents: Vec<Option<String>> = Vec::new();
        for c in chosen.iter().flatten() {
            let p = parent_of(c);
            if !parents.contains(&p) {
                parents.push(p);
            }
        }

        // Categories sort in their own scope, separately from the channels inside them.
        if (categories > 0 && categories < ids.len()) || (categories == 0 && parents.len() > 1) {
            return Err(ToolError::new("order mixes channels from different scopes.")
                .code("MIXED_SCOPE")
                .hint("Order the categories in one call, then the channels inside each category in separate calls.")
                .into());
        }

        // Lay out the whole scope: unlisted siblings keep their slots, listed ones
        // fill the slots the listed set occupied, in the requested order.
        let parent = if categories > 0 {
            None
        } else {
            parents.first().cloned().flatten()
        };
        let siblings = sorted(
            channels
                .iter()
                .filter(|c| {
                    if categories > 0 {
                        is_category(c)
                    } else {
                        !is_category(c) && parent_of(c) == parent
                    }
                })
                .cloned()
                .collect(),
        );
        let mut queue = ids.clone().into_iter();
        let layout: Vec<String> = siblings
            .iter()
            .map(|c| {
                if ids.iter().any(|i| i == id(c)) {
                    queue.next().unwrap_or_default()
                } else {
                    id(c).to_string()
                }
            })
            .collect();

        let changes: Vec<Value> = layout
            .iter()
            .enumerate()
            .filter(|(index, cid)| {
                siblings
                    .iter()
                    .find(|c| id(c) == cid.as_str())
                    .map(position)
                    != Some(*index as i64)
            })
            .map(|(index, cid)| json!({ "id": cid, "position": index }))
            .collect();

        if !changes.is_empty() {
            ctx.rest
                .patch(
                    &format!("/guilds/{guild_id}/channels"),
                    Value::Array(changes.clone()),
                    a.reason().as_deref(),
                )
                .await?;
        }

        ctx.resolver.invalidate_channels(&guild_id);
        let (one, many) = if categories > 0 {
            ("category", "categories")
        } else {
            ("channel", "channels")
        };
        let data: Vec<Value> = ids
            .iter()
            .map(|cid| {
                let name = by_id(cid).and_then(|c| st(c, "name")).unwrap_or(cid);
                let slot = layout
                    .iter()
                    .position(|l| l == cid)
                    .map_or(-1, |p| p as i64);
                json!({ "position": slot, "channel": name })
            })
            .collect();
        Ok(Outcome::with(
            format!(
                "Reordered {}, top to bottom ({} changed).",
                plural_as(ids.len(), one, many),
                plural(changes.len(), "position")
            ),
            Value::Array(data),
        ))
    })
}
