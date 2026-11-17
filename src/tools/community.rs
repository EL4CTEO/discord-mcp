//! Community tools: scheduled events, AutoMod rules, custom emojis and invite links.
//!
//! Every mutating action Discord lets a bot abuse (deleting, disabling a safety
//! rule, revoking a link) is gated behind DISCORD_ALLOW_DESTRUCTIVE in the
//! handler itself, so list and create stay usable by default.

use super::util::plural;
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::{Error, Result, ToolError, destructive_disabled};
use crate::format::{
    Detail, GUILD_STAGE_VOICE, GUILD_VOICE, channel_type_name, ctype, format_user,
};
use crate::js::{clip, parse_date_ms};
use crate::json::{Obj, arr, b, id, present, s, st};
use crate::obj;
use crate::resolve::{is_snowflake, normalize};
use crate::rest::{q, qo};
use crate::text::{EmojiRef, parse_emoji};
use crate::upload::{UploadPolicy, UploadSource, load_upload};
use base64::Engine;
use futures::future::BoxFuture;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

#[derive(Clone)]
struct Item {
    id: String,
    name: String,
    value: Value,
}

/// Picks one item by ID or name: an ID must match exactly; a name must match
/// exactly, else after loosening. Failures list the real options.
fn pick(items: &[Item], query: &str, kind: &str, loosen: fn(&str) -> String) -> Result<Item> {
    let wanted = crate::js::trim(query);
    if is_snowflake(wanted)
        && let Some(found) = items.iter().find(|i| i.id == wanted)
    {
        return Ok(found.clone());
    }

    let literal: Vec<&Item> = items.iter().filter(|i| i.name == wanted).collect();
    if literal.len() == 1 {
        return Ok(literal[0].clone());
    }
    let target = loosen(wanted);
    let matches: Vec<&Item> = items.iter().filter(|i| loosen(&i.name) == target).collect();
    if matches.len() == 1 {
        return Ok(matches[0].clone());
    }
    if matches.is_empty() {
        let names = items
            .iter()
            .take(25)
            .map(|i| i.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(
            ToolError::new(format!("No {kind} named \"{wanted}\" was found."))
                .code("NOT_FOUND")
                .hint(if names.is_empty() {
                    format!("This server has no {kind}s.")
                } else {
                    format!("Available {kind}s: {names}")
                })
                .into(),
        );
    }
    let list = matches
        .iter()
        .take(15)
        .map(|m| format!("{} ({})", m.name, m.id))
        .collect::<Vec<_>>()
        .join(", ");
    Err(ToolError::new(format!(
        "\"{wanted}\" matches {} {kind}s, so it is ambiguous.",
        matches.len()
    ))
    .code("AMBIGUOUS")
    .hint(format!("Pass the exact name or the ID. Matches: {list}"))
    .into())
}

fn items_of(list: &[Value]) -> Vec<Item> {
    list.iter()
        .map(|v| Item {
            id: id(v).to_string(),
            name: s(v, "name").unwrap_or("").to_string(),
            value: v.clone(),
        })
        .collect()
}

/// Long lists keep their first few entries in compact output; full returns them all.
const SAMPLE: usize = 10;

fn sampled(values: &[Value], detail: Detail) -> Option<Vec<Value>> {
    if values.is_empty() {
        return None;
    }
    if detail == Detail::Full || values.len() <= SAMPLE {
        return Some(values.to_vec());
    }
    let mut out = values[..SAMPLE].to_vec();
    out.push(format!("and {} more", values.len() - SAMPLE).into());
    Some(out)
}

// ---------------------------------------------------------------------------
// Scheduled events
// ---------------------------------------------------------------------------

fn event_status(name: &str) -> i64 {
    match name {
        "active" => 2,
        "completed" => 3,
        "canceled" => 4,
        _ => 1,
    }
}

fn event_status_name(v: i64) -> &'static str {
    match v {
        2 => "active",
        3 => "completed",
        4 => "canceled",
        _ => "scheduled",
    }
}

const STAGE: i64 = 1;
const VOICE: i64 = 2;
const EXTERNAL: i64 = 3;

fn entity_name(v: i64) -> &'static str {
    match v {
        STAGE => "stage",
        VOICE => "voice",
        _ => "external",
    }
}

fn format_event(event: &Value, detail: Detail) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), id(event).into());
    out.insert("name".into(), s(event, "name").unwrap_or("").into());
    out.insert(
        "status".into(),
        event_status_name(event.get("status").and_then(Value::as_i64).unwrap_or(1)).into(),
    );
    out.insert(
        "entity".into(),
        entity_name(
            event
                .get("entity_type")
                .and_then(Value::as_i64)
                .unwrap_or(EXTERNAL),
        )
        .into(),
    );
    out.insert(
        "start".into(),
        event
            .get("scheduled_start_time")
            .cloned()
            .unwrap_or(Value::Null),
    );
    if let Some(end) = st(event, "scheduled_end_time") {
        out.insert("end".into(), end.into());
    }
    if let Some(loc) = present(event, "entity_metadata").and_then(|m| st(m, "location")) {
        out.insert("location".into(), loc.into());
    }
    if let Some(c) = st(event, "channel_id") {
        out.insert("channel_id".into(), c.into());
    }
    if let Some(n) = event.get("user_count") {
        out.insert("interested".into(), n.clone());
    }
    if detail == Detail::Full {
        if let Some(d) = st(event, "description") {
            out.insert("description".into(), clip(d, 1000).into());
        }
        if let Some(c) = st(event, "creator_id") {
            out.insert("creator_id".into(), c.into());
        }
    }
    Value::Object(out)
}

/// Discord needs the end after the start; refusing a bad pair here saves a round trip.
fn check_window(start: &str, end: Option<&str>) -> Result<()> {
    if let Some(end) = end.filter(|e| !e.is_empty())
        && parse_date_ms(end) <= parse_date_ms(start)
    {
        return Err(ToolError::new("end_time must be after start_time.")
            .code("INVALID_ARGS")
            .hint("Pass an end_time later than start_time, both as ISO 8601 times.")
            .into());
    }
    Ok(())
}

/// A start time in the past would schedule an event that is already overdue.
fn check_future(start: &str) -> Result<()> {
    if parse_date_ms(start) <= crate::js::now_ms() as f64 {
        return Err(ToolError::new("start_time must be in the future.")
            .code("INVALID_ARGS")
            .hint("Use an ISO time after now, e.g. 2026-12-01T18:00:00Z.")
            .into());
    }
    Ok(())
}

struct Place {
    entity_type: i64,
    channel_id: Option<String>,
    location: Option<String>,
}

/// Where an event happens: a free-text location (external), or a voice or stage channel.
async fn place_of(
    ctx: &Ctx,
    guild_id: &str,
    location: Option<String>,
    channel: Option<String>,
) -> Result<Place> {
    if let Some(location) = location {
        return Ok(Place {
            entity_type: EXTERNAL,
            channel_id: None,
            location: Some(location),
        });
    }
    let Some(channel) = channel else {
        return Err(ToolError::new(
            "Pass `location` for an external event, or `channel` for a voice or stage event.",
        )
        .code("MISSING_ARG")
        .into());
    };

    let channel_id = ctx.resolver.channel_id(&channel, guild_id, true).await?;
    let Some(found) = ctx.resolver.find_channel(guild_id, &channel_id).await? else {
        return Err(ToolError::new(format!("Channel {channel} is not a top-level channel of this server."))
            .code("NOT_FOUND")
            .hint("Events can only be hosted by voice or stage channels. Call discord_list_channels for valid channels.")
            .into());
    };
    let t = ctype(&found);
    if t != GUILD_VOICE && t != GUILD_STAGE_VOICE {
        return Err(ToolError::new(format!(
            "Events can only be hosted by voice or stage channels, not {}.",
            channel_type_name(t)
        ))
        .code("INVALID_ARGS")
        .hint("Pass a voice or stage channel, or use `location` for an external event.")
        .into());
    }
    Ok(Place {
        entity_type: if t == GUILD_STAGE_VOICE { STAGE } else { VOICE },
        channel_id: Some(channel_id),
        location: None,
    })
}

async fn list_events(ctx: &Ctx, guild_id: &str) -> Result<Vec<Value>> {
    Ok(ctx
        .rest
        .get(
            &format!("/guilds/{guild_id}/scheduled-events"),
            &[("with_user_count", q(true))],
            None,
        )
        .await?
        .as_array()
        .cloned()
        .unwrap_or_default())
}

fn loose(value: &str) -> String {
    normalize(value)
}

/// Just the ID: an ID is used as-is, a name costs one listing.
async fn event_id_of(ctx: &Ctx, guild_id: &str, reference: &str) -> Result<String> {
    let trimmed = crate::js::trim(reference);
    if is_snowflake(trimmed) {
        return Ok(trimmed.to_string());
    }
    Ok(pick(
        &items_of(&list_events(ctx, guild_id).await?),
        trimmed,
        "scheduled event",
        loose,
    )?
    .id)
}

/// The whole event, which edit needs to check its times and place.
async fn event_of(ctx: &Ctx, guild_id: &str, reference: &str) -> Result<Value> {
    let trimmed = crate::js::trim(reference);
    if is_snowflake(trimmed) {
        return ctx
            .rest
            .get(
                &format!("/guilds/{guild_id}/scheduled-events/{trimmed}"),
                &[],
                None,
            )
            .await;
    }
    Ok(pick(
        &items_of(&list_events(ctx, guild_id).await?),
        trimmed,
        "scheduled event",
        loose,
    )?
    .value)
}

pub fn manage_scheduled_events() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Needs Create Events to schedule an event and Manage Events to edit or delete one. Voice and stage events \
             also need the bot to see that channel.",
        ),
        ..ToolDef::new("discord_scheduled_events", scheduled_events_handler)
    }
}

fn scheduled_events_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_else(|| "list".into());
        if action == "delete" && !ctx.config.allow_destructive {
            return Err(destructive_disabled("discord_scheduled_events delete"));
        }
        // Cancelling tells everyone interested that the event is off, so it is gated like a delete.
        if action == "edit"
            && a.str("status").as_deref() == Some("canceled")
            && !ctx.config.allow_destructive
        {
            return Err(destructive_disabled("discord_scheduled_events cancel"));
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let event_ref = a.str("event").filter(|e| !e.is_empty());
        let reason = a.reason();

        match action.as_str() {
            "list" => {
                let events = list_events(&ctx, &guild_id).await?;
                let detail = a.detail();
                Ok(Outcome::with(
                    format!(
                        "{} in server {guild_id}.",
                        plural(events.len(), "scheduled event")
                    ),
                    Value::Array(events.iter().map(|e| format_event(e, detail)).collect()),
                ))
            }
            "users" => {
                let Some(event_ref) = event_ref else {
                    return Err(
                        ToolError::new("`event` is required to list who is interested.")
                            .code("MISSING_ARG")
                            .into(),
                    );
                };
                let event_id = event_id_of(&ctx, &guild_id, &event_ref).await?;
                let limit = a.i64("limit").unwrap_or(50);
                let users = ctx
                    .rest
                    .get(
                        &format!("/guilds/{guild_id}/scheduled-events/{event_id}/users"),
                        &[("limit", q(limit)), ("after", qo(a.str("after")))],
                        None,
                    )
                    .await?;
                let users = users.as_array().cloned().unwrap_or_default();
                let more = match users.last() {
                    Some(last) if users.len() as i64 == limit => format!(
                        " More may follow: pass after=\"{}\".",
                        last.get("user").map_or("", id)
                    ),
                    _ => String::new(),
                };
                Ok(Outcome::with(
                    format!(
                        "{} interested in event {event_id}.{more}",
                        plural(users.len(), "user")
                    ),
                    Value::Array(
                        users
                            .iter()
                            .map(|u| format_user(u.get("user").unwrap_or(&Value::Null)))
                            .collect(),
                    ),
                ))
            }
            "create" => {
                let (Some(name), Some(start)) = (
                    a.str("name").filter(|n| !n.is_empty()),
                    a.str("start_time").filter(|n| !n.is_empty()),
                ) else {
                    return Err(ToolError::new(
                        "`name` and `start_time` are required to create an event.",
                    )
                    .code("MISSING_ARG")
                    .into());
                };
                let location = a.str("location");
                let channel = a.str("channel");
                if location.is_none() == channel.is_none() {
                    return Err(ToolError::new("Give either `location` (external event) or `channel` (voice or stage), not both or neither.")
                        .code("INVALID_ARGS")
                        .into());
                }
                let end = a.str("end_time");
                if location.is_some() && end.is_none() {
                    return Err(ToolError::new("An external event needs `end_time`.")
                        .code("MISSING_ARG")
                        .hint("Pass end_time as an ISO 8601 time after start_time.")
                        .into());
                }
                check_future(&start)?;
                check_window(&start, end.as_deref())?;

                let place = place_of(&ctx, &guild_id, location, channel).await?;
                let body = obj! {
                    "name" => name,
                    "privacy_level" => 2,
                    "scheduled_start_time" => start,
                    "scheduled_end_time" => end,
                    "description" => a.str("description").filter(|d| !d.is_empty()),
                    "entity_type" => place.entity_type,
                    "channel_id" => place.channel_id,
                    "entity_metadata" => place.location.map(|l| json!({ "location": l })),
                };
                let event = ctx
                    .rest
                    .post(
                        &format!("/guilds/{guild_id}/scheduled-events"),
                        Some(body),
                        reason.as_deref(),
                        vec![],
                    )
                    .await?;
                Ok(Outcome::with(
                    format!(
                        "Created {} event \"{}\" ({}).",
                        entity_name(
                            event
                                .get("entity_type")
                                .and_then(Value::as_i64)
                                .unwrap_or(EXTERNAL)
                        ),
                        s(&event, "name").unwrap_or(""),
                        id(&event)
                    ),
                    format_event(&event, Detail::Compact),
                ))
            }
            "edit" => {
                let Some(event_ref) = event_ref else {
                    return Err(ToolError::new("`event` is required to edit an event.")
                        .code("MISSING_ARG")
                        .into());
                };
                let touched = [
                    "name",
                    "description",
                    "start_time",
                    "end_time",
                    "status",
                    "location",
                    "channel",
                ]
                .iter()
                .any(|k| a.has(k));
                if !touched {
                    return Err(ToolError::new(
                        "Nothing to change: pass at least one field to update.",
                    )
                    .code("MISSING_ARG")
                    .into());
                }
                if a.has("location") && a.has("channel") {
                    return Err(
                        ToolError::new("Give either `location` or `channel`, not both.")
                            .code("INVALID_ARGS")
                            .into(),
                    );
                }

                let start = a.str("start_time");
                let end = a.str("end_time");
                if let Some(st) = &start {
                    check_future(st)?;
                }
                let event = event_of(&ctx, &guild_id, &event_ref).await?;
                let current_end = s(&event, "scheduled_end_time").map(str::to_string);
                if start.is_some() || end.is_some() {
                    let start_v = start
                        .clone()
                        .or_else(|| s(&event, "scheduled_start_time").map(str::to_string))
                        .unwrap_or_default();
                    check_window(
                        &start_v,
                        end.clone().or_else(|| current_end.clone()).as_deref(),
                    )?;
                }

                let mut body = Map::new();
                if let Some(n) = a.str("name") {
                    body.insert("name".into(), n.into());
                }
                if let Some(d) = a.str("description") {
                    body.insert(
                        "description".into(),
                        if d.is_empty() { Value::Null } else { d.into() },
                    );
                }
                if let Some(st) = &start {
                    body.insert("scheduled_start_time".into(), st.clone().into());
                }
                if let Some(e) = &end {
                    body.insert("scheduled_end_time".into(), e.clone().into());
                }
                if let Some(status) = a.str("status") {
                    body.insert("status".into(), event_status(&status).into());
                }

                if a.has("location") || a.has("channel") {
                    let place =
                        place_of(&ctx, &guild_id, a.str("location"), a.str("channel")).await?;
                    if place.entity_type == EXTERNAL
                        && end
                            .clone()
                            .or(current_end.clone())
                            .filter(|e| !e.is_empty())
                            .is_none()
                    {
                        return Err(ToolError::new("An external event needs an end time.")
                            .code("MISSING_ARG")
                            .hint("Pass end_time as well, since this event has none set.")
                            .into());
                    }
                    body.insert("entity_type".into(), place.entity_type.into());
                    body.insert(
                        "channel_id".into(),
                        place.channel_id.map_or(Value::Null, Value::from),
                    );
                    body.insert(
                        "entity_metadata".into(),
                        place
                            .location
                            .map_or(Value::Null, |l| json!({ "location": l })),
                    );
                }

                let updated = ctx
                    .rest
                    .patch(
                        &format!("/guilds/{guild_id}/scheduled-events/{}", id(&event)),
                        Value::Object(body),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::with(
                    format!(
                        "Updated scheduled event \"{}\" ({}).",
                        s(&updated, "name").unwrap_or(""),
                        id(&updated)
                    ),
                    format_event(&updated, Detail::Compact),
                ))
            }
            _ => {
                // delete - the only action left. Its gate ran first, before any lookup.
                let Some(event_ref) = event_ref else {
                    return Err(ToolError::new("`event` is required to delete an event.")
                        .code("MISSING_ARG")
                        .into());
                };
                let event_id = event_id_of(&ctx, &guild_id, &event_ref).await?;
                ctx.rest
                    .delete(
                        &format!("/guilds/{guild_id}/scheduled-events/{event_id}"),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::text(format!(
                    "Deleted scheduled event {event_id}."
                )))
            }
        }
    })
}

// ---------------------------------------------------------------------------
// AutoMod
// ---------------------------------------------------------------------------

const TRIGGERS: &[(&str, i64)] = &[
    ("keyword", 1),
    ("spam", 3),
    ("keyword_preset", 4),
    ("mention_spam", 5),
];
const PRESETS: &[(&str, i64)] = &[("profanity", 1), ("sexual_content", 2), ("slurs", 3)];

const BLOCK_MESSAGE: i64 = 1;
const SEND_ALERT: i64 = 2;
const TIMEOUT: i64 = 3;

fn action_name(t: i64) -> String {
    match t {
        1 => "block".into(),
        2 => "alert".into(),
        3 => "timeout".into(),
        4 => "block_interaction".into(),
        other => format!("{other}"),
    }
}

/// Longest timeout Discord accepts for an AutoMod action: 28 days.
const MAX_TIMEOUT_SECONDS: i64 = 2_419_200;

fn trigger_of(t: i64) -> Option<&'static str> {
    TRIGGERS.iter().find(|(_, v)| *v == t).map(|(n, _)| *n)
}

fn trigger_type(name: &str) -> i64 {
    TRIGGERS
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(1, |(_, v)| *v)
}

fn preset_of(t: i64) -> Option<&'static str> {
    PRESETS.iter().find(|(_, v)| *v == t).map(|(n, _)| *n)
}

const TRIGGER_FIELD_NAMES: &[&str] = &[
    "keywords",
    "regex_patterns",
    "allow_list",
    "presets",
    "mention_total_limit",
    "mention_raid_protection",
];

fn trigger_fields(trigger: &str) -> &'static [&'static str] {
    match trigger {
        "keyword" => &["keywords", "regex_patterns", "allow_list"],
        "keyword_preset" => &["presets", "allow_list"],
        "mention_spam" => &["mention_total_limit", "mention_raid_protection"],
        _ => &[],
    }
}

/// The trigger_metadata for a rule, in Discord's wire names. A setting that
/// belongs to another trigger type is refused rather than silently dropped.
fn trigger_settings(trigger: &str, a: &Args, creating: bool) -> Result<Option<Obj>> {
    let allowed = trigger_fields(trigger);
    let stray: Vec<&str> = TRIGGER_FIELD_NAMES
        .iter()
        .copied()
        .filter(|f| a.has(f) && !allowed.contains(f))
        .collect();
    if !stray.is_empty() {
        return Err(ToolError::new(format!(
            "{} {} not apply to a {trigger} rule.",
            stray.join(", "),
            if stray.len() == 1 { "does" } else { "do" }
        ))
        .code("INVALID_ARGS")
        .hint(if allowed.is_empty() {
            format!("A {trigger} rule takes no trigger settings.")
        } else {
            format!("A {trigger} rule accepts: {}.", allowed.join(", "))
        })
        .into());
    }

    let mut out = Map::new();
    match trigger {
        "keyword" => {
            let keywords = a.arr("keywords").map_or(0, Vec::len);
            let regexes = a.arr("regex_patterns").map_or(0, Vec::len);
            if creating && keywords == 0 && regexes == 0 {
                return Err(
                    ToolError::new("A keyword rule needs `keywords` or `regex_patterns`.")
                        .code("MISSING_ARG")
                        .into(),
                );
            }
            // Discord allows 1000 allow-list entries on preset rules but only 100 on keyword rules.
            if a.arr("allow_list").map_or(0, Vec::len) > 100 {
                return Err(ToolError::new(
                    "A keyword rule's allow_list holds at most 100 entries.",
                )
                .code("INVALID_ARGS")
                .into());
            }
            crate::json::put(&mut out, "keyword_filter", a.get("keywords").cloned());
            crate::json::put(&mut out, "regex_patterns", a.get("regex_patterns").cloned());
            crate::json::put(&mut out, "allow_list", a.get("allow_list").cloned());
            Ok(Some(out))
        }
        "keyword_preset" => {
            if creating && a.arr("presets").is_none_or(Vec::is_empty) {
                return Err(ToolError::new(
                    "A keyword_preset rule needs `presets`: profanity, sexual_content or slurs.",
                )
                .code("MISSING_ARG")
                .into());
            }
            if let Some(presets) = a.strs("presets") {
                let values: Vec<Value> = presets
                    .iter()
                    .map(|p| {
                        PRESETS
                            .iter()
                            .find(|(n, _)| n == p)
                            .map_or(Value::Null, |(_, v)| Value::from(*v))
                    })
                    .collect();
                out.insert("presets".into(), values.into());
            }
            crate::json::put(&mut out, "allow_list", a.get("allow_list").cloned());
            Ok(Some(out))
        }
        "mention_spam" => {
            if creating && !a.has("mention_total_limit") {
                return Err(ToolError::new(
                    "A mention_spam rule needs `mention_total_limit` (1-50).",
                )
                .code("MISSING_ARG")
                .into());
            }
            crate::json::put(
                &mut out,
                "mention_total_limit",
                a.get("mention_total_limit").cloned(),
            );
            crate::json::put(
                &mut out,
                "mention_raid_protection_enabled",
                a.get("mention_raid_protection").cloned(),
            );
            Ok(Some(out))
        }
        _ => Ok(None),
    }
}

/// Builds the action list, checking each action's fields against the trigger it runs under.
async fn actions_for(
    ctx: &Ctx,
    guild_id: &str,
    actions: &[Value],
    trigger: &str,
) -> Result<Vec<Value>> {
    let work = actions.iter().map(|action| async move {
        let kind = s(action, "type").unwrap_or("");
        let channel = s(action, "channel");
        let has_duration = action.get("duration_seconds").is_some();
        let has_message = action.get("custom_message").is_some();
        match kind {
            "block" => {
                if channel.is_some() || has_duration {
                    return Err(Error::from(ToolError::new("A block action takes only custom_message.").code("INVALID_ARGS")));
                }
                Ok(obj! {
                    "type" => BLOCK_MESSAGE,
                    "metadata" => action.get("custom_message").map(|m| json!({ "custom_message": m })),
                })
            }
            "alert" => {
                let Some(channel) = channel else {
                    return Err(ToolError::new("An alert action needs `channel`, the channel that receives the alert.").code("MISSING_ARG").into());
                };
                if has_message || has_duration {
                    return Err(ToolError::new("An alert action takes only channel.").code("INVALID_ARGS").into());
                }
                let channel_id = ctx.resolver.channel_id(channel, guild_id, true).await?;
                Ok(json!({ "type": SEND_ALERT, "metadata": { "channel_id": channel_id } }))
            }
            _ => {
                let Some(duration) = action.get("duration_seconds") else {
                    return Err(ToolError::new(format!("A timeout action needs duration_seconds (up to {MAX_TIMEOUT_SECONDS}).")).code("MISSING_ARG").into());
                };
                if channel.is_some() || has_message {
                    return Err(ToolError::new("A timeout action takes only duration_seconds.").code("INVALID_ARGS").into());
                }
                if trigger != "keyword" && trigger != "mention_spam" {
                    return Err(ToolError::new(format!("A timeout action cannot be used with a {trigger} rule."))
                        .code("INVALID_ARGS")
                        .hint("Timeouts only work with keyword and mention_spam rules. Use block or alert with this trigger.")
                        .into());
                }
                Ok(json!({ "type": TIMEOUT, "metadata": { "duration_seconds": duration } }))
            }
        }
    });
    futures::future::try_join_all(work).await
}

struct AutoModNames {
    roles: Vec<(String, String)>,
    channels: Vec<(String, String)>,
}

fn name_in(list: &[(String, String)], key: &str) -> Option<String> {
    list.iter().find(|(i, _)| i == key).map(|(_, n)| n.clone())
}

async fn names_for(ctx: &Ctx, guild_id: &str) -> Result<AutoModNames> {
    let (roles, channels) = tokio::try_join!(
        ctx.resolver.role_names(guild_id),
        ctx.resolver.channels(guild_id)
    )?;
    let channels = channels
        .iter()
        .filter_map(|c| st(c, "name").map(|n| (id(c).to_string(), n.to_string())))
        .collect();
    Ok(AutoModNames { roles, channels })
}

async fn exemptions_of(
    ctx: &Ctx,
    guild_id: &str,
    roles: Option<Vec<String>>,
    channels: Option<Vec<String>>,
) -> Result<Obj> {
    let (exempt_roles, exempt_channels) = tokio::try_join!(
        async {
            match &roles {
                Some(r) => futures::future::try_join_all(
                    r.iter().map(|x| ctx.resolver.role_id(x, guild_id, true)),
                )
                .await
                .map(Some),
                None => Ok(None),
            }
        },
        async {
            match &channels {
                Some(c) => futures::future::try_join_all(
                    c.iter().map(|x| ctx.resolver.channel_id(x, guild_id, true)),
                )
                .await
                .map(Some),
                None => Ok(None),
            }
        },
    )?;
    // @everyone's role ID is the guild's own ID, so exempting it exempts every member and the rule does nothing.
    if exempt_roles
        .as_ref()
        .is_some_and(|r| r.iter().any(|x| x == guild_id))
        && !ctx.config.allow_destructive
    {
        return Err(destructive_disabled("discord_automod exempting @everyone"));
    }
    let mut out = Map::new();
    crate::json::put(&mut out, "exempt_roles", exempt_roles);
    crate::json::put(&mut out, "exempt_channels", exempt_channels);
    Ok(out)
}

fn describe_action(action: &Value, channels: &[(String, String)]) -> String {
    let t = action.get("type").and_then(Value::as_i64).unwrap_or(0);
    let meta = present(action, "metadata");
    if t == SEND_ALERT
        && let Some(cid) = meta.and_then(|m| st(m, "channel_id"))
    {
        return format!(
            "alert #{}",
            name_in(channels, cid).unwrap_or_else(|| cid.to_string())
        );
    }
    if t == TIMEOUT
        && let Some(d) = meta.and_then(|m| m.get("duration_seconds"))
    {
        return format!("timeout {d}s");
    }
    action_name(t)
}

fn format_rule(rule: &Value, detail: Detail, names: &AutoModNames) -> Value {
    let empty = Value::Object(Map::new());
    let meta = present(rule, "trigger_metadata").unwrap_or(&empty);
    let t = rule
        .get("trigger_type")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut out = Map::new();
    out.insert("id".into(), id(rule).into());
    out.insert("name".into(), s(rule, "name").unwrap_or("").into());
    out.insert(
        "enabled".into(),
        rule.get("enabled").cloned().unwrap_or(Value::Bool(false)),
    );
    out.insert(
        "trigger".into(),
        trigger_of(t)
            .map_or_else(|| format!("type_{t}"), str::to_string)
            .into(),
    );
    out.insert(
        "actions".into(),
        arr(rule, "actions")
            .iter()
            .map(|x| Value::from(describe_action(x, &names.channels)))
            .collect::<Vec<_>>()
            .into(),
    );

    if let Some(k) = sampled(arr(meta, "keyword_filter"), detail) {
        out.insert("keywords".into(), k.into());
    }
    if let Some(r) = sampled(arr(meta, "regex_patterns"), detail) {
        out.insert("regex_patterns".into(), r.into());
    }
    if let Some(al) = sampled(arr(meta, "allow_list"), detail) {
        out.insert("allow_list".into(), al.into());
    }
    let presets = arr(meta, "presets");
    if !presets.is_empty() {
        let names: Vec<Value> = presets
            .iter()
            .map(|p| {
                p.as_i64().and_then(preset_of).map_or_else(
                    || Value::from(crate::gateway::js_string(Some(p))),
                    Value::from,
                )
            })
            .collect();
        out.insert("presets".into(), names.into());
    }
    if let Some(n) = meta.get("mention_total_limit") {
        out.insert("mention_total_limit".into(), n.clone());
    }
    if let Some(n) = meta.get("mention_raid_protection_enabled") {
        out.insert("mention_raid_protection".into(), n.clone());
    }
    let roles = arr(rule, "exempt_roles");
    if !roles.is_empty() {
        let list: Vec<Value> = roles
            .iter()
            .filter_map(Value::as_str)
            .map(|r| {
                name_in(&names.roles, r)
                    .unwrap_or_else(|| r.to_string())
                    .into()
            })
            .collect();
        out.insert("exempt_roles".into(), list.into());
    }
    let channels = arr(rule, "exempt_channels");
    if !channels.is_empty() {
        let list: Vec<Value> = channels
            .iter()
            .filter_map(Value::as_str)
            .map(|c| {
                name_in(&names.channels, c)
                    .unwrap_or_else(|| c.to_string())
                    .into()
            })
            .collect();
        out.insert("exempt_channels".into(), list.into());
    }
    Value::Object(out)
}

async fn list_rules(ctx: &Ctx, guild_id: &str) -> Result<Vec<Value>> {
    Ok(ctx
        .rest
        .get(
            &format!("/guilds/{guild_id}/auto-moderation/rules"),
            &[],
            None,
        )
        .await?
        .as_array()
        .cloned()
        .unwrap_or_default())
}

async fn rule_of(ctx: &Ctx, guild_id: &str, reference: &str) -> Result<Value> {
    Ok(pick(
        &items_of(&list_rules(ctx, guild_id).await?),
        reference,
        "auto-moderation rule",
        loose,
    )?
    .value)
}

pub fn manage_automod() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Needs Manage Server to list, create, edit or delete AutoMod rules.",
        ),
        ..ToolDef::new("discord_automod", automod_handler)
    }
}

fn automod_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_else(|| "list".into());
        if action == "delete" && !ctx.config.allow_destructive {
            return Err(destructive_disabled("discord_automod delete"));
        }
        if action == "edit" && a.opt_bool("enabled") == Some(false) && !ctx.config.allow_destructive
        {
            return Err(destructive_disabled(
                "discord_automod edit with enabled=false (disabling a rule)",
            ));
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let detail = a.detail();
        let reason = a.reason();
        let rule_ref = a.str("rule").filter(|r| !r.is_empty());

        match action.as_str() {
            "list" => {
                let (rules, names) =
                    tokio::try_join!(list_rules(&ctx, &guild_id), names_for(&ctx, &guild_id))?;
                Ok(Outcome::with(
                    format!(
                        "{} in server {guild_id}.",
                        plural(rules.len(), "AutoMod rule")
                    ),
                    Value::Array(
                        rules
                            .iter()
                            .map(|r| format_rule(r, detail, &names))
                            .collect(),
                    ),
                ))
            }
            "create" => {
                let (Some(name), Some(trigger)) =
                    (a.str("name").filter(|n| !n.is_empty()), a.str("trigger"))
                else {
                    return Err(ToolError::new(
                        "`name` and `trigger` are required to create a rule.",
                    )
                    .code("MISSING_ARG")
                    .hint("trigger is one of keyword, spam, keyword_preset or mention_spam.")
                    .into());
                };
                let settings = trigger_settings(&trigger, &a, true)?;
                let actions_in = a
                    .arr("actions")
                    .cloned()
                    .unwrap_or_else(|| vec![json!({ "type": "block" })]);
                let actions = actions_for(&ctx, &guild_id, &actions_in, &trigger).await?;
                let exemptions = exemptions_of(
                    &ctx,
                    &guild_id,
                    a.strs("exempt_roles"),
                    a.strs("exempt_channels"),
                )
                .await?;

                let mut body = Map::new();
                body.insert("name".into(), name.into());
                body.insert("event_type".into(), 1.into());
                body.insert("trigger_type".into(), trigger_type(&trigger).into());
                crate::json::put(&mut body, "trigger_metadata", settings);
                body.insert("actions".into(), actions.into());
                body.insert(
                    "enabled".into(),
                    a.opt_bool("enabled").unwrap_or(true).into(),
                );
                body.extend(exemptions);

                let rule = ctx
                    .rest
                    .post(
                        &format!("/guilds/{guild_id}/auto-moderation/rules"),
                        Some(Value::Object(body)),
                        reason.as_deref(),
                        vec![],
                    )
                    .await?;
                let names = names_for(&ctx, &guild_id).await?;
                Ok(Outcome::with(
                    format!(
                        "Created {trigger} rule \"{}\" ({}).",
                        s(&rule, "name").unwrap_or(""),
                        id(&rule)
                    ),
                    format_rule(&rule, detail, &names),
                ))
            }
            "edit" => {
                let Some(rule_ref) = rule_ref else {
                    return Err(ToolError::new("`rule` is required to edit a rule.")
                        .code("MISSING_ARG")
                        .into());
                };
                if a.has("trigger") {
                    return Err(ToolError::new("A rule's trigger type cannot be changed.")
                        .code("INVALID_ARGS")
                        .hint("Delete the rule and create a new one with the trigger you want.")
                        .into());
                }
                let fields = [
                    "name",
                    "enabled",
                    "actions",
                    "exempt_roles",
                    "exempt_channels",
                    "keywords",
                    "regex_patterns",
                    "allow_list",
                    "presets",
                    "mention_total_limit",
                    "mention_raid_protection",
                ];
                if !fields.iter().any(|f| a.has(f)) {
                    return Err(ToolError::new(
                        "Nothing to change: pass at least one field to update.",
                    )
                    .code("MISSING_ARG")
                    .into());
                }

                let current = rule_of(&ctx, &guild_id, &rule_ref).await?;
                let current_type = current
                    .get("trigger_type")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let Some(trigger) = trigger_of(current_type) else {
                    return Err(ToolError::new(format!("This rule's trigger type ({current_type}) cannot be edited here."))
                        .code("INVALID_ARGS")
                        .hint("Only keyword, spam, keyword_preset and mention_spam rules can be edited with this tool.")
                        .into());
                };

                let actions = match a.arr("actions") {
                    Some(list) => Some(actions_for(&ctx, &guild_id, list, trigger).await?),
                    None => None,
                };
                let empty = Value::Object(Map::new());
                let current_meta = present(&current, "trigger_metadata")
                    .unwrap_or(&empty)
                    .clone();
                if !ctx.config.allow_destructive {
                    // A rule that blocks or times out is the point of AutoMod.
                    let enforces = |x: &Value| {
                        matches!(
                            x.get("type").and_then(Value::as_i64),
                            Some(BLOCK_MESSAGE | TIMEOUT)
                        )
                    };
                    if let Some(next) = &actions
                        && arr(&current, "actions").iter().any(enforces)
                        && !next.iter().any(enforces)
                    {
                        return Err(destructive_disabled("discord_automod removing enforcement"));
                    }
                    let keywords = a
                        .arr("keywords")
                        .map_or_else(|| arr(&current_meta, "keyword_filter").len(), Vec::len);
                    let regexes = a
                        .arr("regex_patterns")
                        .map_or_else(|| arr(&current_meta, "regex_patterns").len(), Vec::len);
                    if trigger == "keyword" && keywords == 0 && regexes == 0 {
                        return Err(destructive_disabled("discord_automod emptying the filter"));
                    }
                }

                let mut body = Map::new();
                if let Some(n) = a.str("name") {
                    body.insert("name".into(), n.into());
                }
                if let Some(e) = a.opt_bool("enabled") {
                    body.insert("enabled".into(), e.into());
                }
                if let Some(acts) = actions {
                    body.insert("actions".into(), acts.into());
                }
                if a.has("exempt_roles") || a.has("exempt_channels") {
                    body.extend(
                        exemptions_of(
                            &ctx,
                            &guild_id,
                            a.strs("exempt_roles"),
                            a.strs("exempt_channels"),
                        )
                        .await?,
                    );
                }

                // Merged into the existing metadata: a PATCH replaces it wholesale.
                if let Some(settings) = trigger_settings(trigger, &a, false)?
                    && !settings.is_empty()
                {
                    body.insert(
                        "trigger_metadata".into(),
                        crate::json::spread(&current_meta, &Value::Object(settings)),
                    );
                }

                let rule = ctx
                    .rest
                    .patch(
                        &format!("/guilds/{guild_id}/auto-moderation/rules/{}", id(&current)),
                        Value::Object(body),
                        reason.as_deref(),
                    )
                    .await?;
                let names = names_for(&ctx, &guild_id).await?;
                Ok(Outcome::with(
                    format!(
                        "Updated rule \"{}\" ({}).",
                        s(&rule, "name").unwrap_or(""),
                        id(&rule)
                    ),
                    format_rule(&rule, detail, &names),
                ))
            }
            _ => {
                let Some(rule_ref) = rule_ref else {
                    return Err(ToolError::new("`rule` is required to delete a rule.")
                        .code("MISSING_ARG")
                        .into());
                };
                let trimmed = crate::js::trim(&rule_ref).to_string();
                let rule_id = if is_snowflake(&trimmed) {
                    trimmed
                } else {
                    id(&rule_of(&ctx, &guild_id, &rule_ref).await?).to_string()
                };
                ctx.rest
                    .delete(
                        &format!("/guilds/{guild_id}/auto-moderation/rules/{rule_id}"),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(Outcome::text(format!("Deleted AutoMod rule {rule_id}.")))
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Emojis
// ---------------------------------------------------------------------------

/// Discord's limit for a custom emoji image.
const EMOJI_MAX_BYTES: u64 = 256 * 1024;

/// The image type Discord will accept, from what the server said or the file extension.
fn image_mime(name: &str, content_type: Option<&str>) -> Option<&'static str> {
    const IMAGE: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
    if let Some(ct) = content_type
        && let Some(m) = IMAGE.iter().find(|m| **m == ct)
    {
        return Some(m);
    }
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn format_emoji(emoji: &Value, role_names: Option<&[(String, String)]>) -> Value {
    let eid = s(emoji, "id").unwrap_or("");
    let name = s(emoji, "name").unwrap_or("");
    let animated = b(emoji, "animated");
    let mut out = Map::new();
    out.insert("id".into(), eid.into());
    out.insert("name".into(), name.into());
    out.insert(
        "mention".into(),
        format!("<{}:{name}:{eid}>", if animated { "a" } else { "" }).into(),
    );
    if animated {
        out.insert("animated".into(), true.into());
    }
    let roles = arr(emoji, "roles");
    if !roles.is_empty() {
        let list: Vec<Value> = roles
            .iter()
            .filter_map(Value::as_str)
            .map(|r| {
                role_names
                    .and_then(|n| name_in(n, r))
                    .unwrap_or_else(|| r.to_string())
                    .into()
            })
            .collect();
        out.insert("roles".into(), list.into());
    }
    if emoji.get("available") == Some(&Value::Bool(false)) {
        out.insert("available".into(), false.into());
    }
    Value::Object(out)
}

static NAME_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_]{2,32}):([0-9]{17,20})$").expect("valid regex"));

/// An emoji from an ID, a '<:name:id>' or 'name:id' form, or a name looked up in the server.
async fn emoji_of(ctx: &Ctx, guild_id: &str, reference: &str) -> Result<(String, Option<String>)> {
    match parse_emoji(reference) {
        EmojiRef::Lookup(name) => {
            let emojis = ctx.resolver.emojis(guild_id).await?;
            let named: Vec<Item> = emojis
                .iter()
                .filter_map(|e| {
                    let eid = st(e, "id")?;
                    let n = st(e, "name")?;
                    Some(Item {
                        id: eid.to_string(),
                        name: n.to_string(),
                        value: Value::Null,
                    })
                })
                .collect();
            let found = pick(&named, &name, "emoji", str::to_lowercase)?;
            Ok((found.id, Some(found.name)))
        }
        EmojiRef::Route(route) => {
            if is_snowflake(&route) {
                return Ok((route, None));
            }
            if let Some(c) = NAME_ID.captures(&route) {
                return Ok((c[2].to_string(), Some(c[1].to_string())));
            }
            Err(ToolError::new(format!("\"{reference}\" is not a custom server emoji."))
                .code("INVALID_ARGS")
                .hint("Pass the emoji's name, its ID, or '<:name:id>'. Unicode emojis cannot be managed here.")
                .into())
        }
    }
}

pub fn manage_emojis() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Needs Create Guild Expressions to add an emoji and Manage Guild Expressions to rename or delete one.",
        ),
        extra_check: Some(check_emoji_file),
        ..ToolDef::new("discord_manage_emojis", emojis_handler)
    }
}

/// The zod refinement on the emoji file: exactly one of path or url.
fn check_emoji_file(args: &Obj) -> Vec<(String, String)> {
    match args.get("file") {
        Some(f) if f.get("path").is_some() == f.get("url").is_some() => {
            vec![("file".into(), "Give exactly one of path or url.".into())]
        }
        _ => vec![],
    }
}

fn emojis_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_else(|| "list".into());
        if action == "delete" && !ctx.config.allow_destructive {
            return Err(destructive_disabled("discord_manage_emojis delete"));
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let reason = a.reason();
        let emoji_ref = a.str("emoji").filter(|e| !e.is_empty());
        let name = a.str("name").filter(|n| !n.is_empty());

        match action.as_str() {
            "list" => {
                let (emojis, role_names) = tokio::try_join!(
                    ctx.resolver.emojis(&guild_id),
                    ctx.resolver.role_names(&guild_id)
                )?;
                Ok(Outcome::with(
                    format!("{} in server {guild_id}.", plural(emojis.len(), "emoji")),
                    Value::Array(
                        emojis
                            .iter()
                            .map(|e| format_emoji(e, Some(&role_names)))
                            .collect(),
                    ),
                ))
            }
            "create" => {
                let (Some(name), Some(file)) = (name, a.get("file").cloned()) else {
                    return Err(
                        ToolError::new("`name` and `file` are required to add an emoji.")
                            .code("MISSING_ARG")
                            .into(),
                    );
                };
                let policy = UploadPolicy {
                    roots: ctx.config.upload_dirs.as_deref(),
                    cancel: Some(&ctx.cancel),
                    secrets: vec![ctx.config.token.clone()],
                    max_bytes: Some(EMOJI_MAX_BYTES),
                };
                let source = UploadSource {
                    path: s(&file, "path").map(str::to_string),
                    url: s(&file, "url").map(str::to_string),
                    ..Default::default()
                };
                let loaded = load_upload(&source, &policy).await?;
                if loaded.data.len() as u64 > EMOJI_MAX_BYTES {
                    return Err(ToolError::new(format!(
                        "\"{}\" is {} KiB, over Discord's 256 KiB emoji limit.",
                        loaded.name,
                        (loaded.data.len() as u64).div_ceil(1024)
                    ))
                    .code("FILE_TOO_LARGE")
                    .hint("Shrink the image, for example to 128x128 pixels, and try again.")
                    .into());
                }
                let Some(mime) = image_mime(&loaded.name, loaded.content_type.as_deref()) else {
                    return Err(ToolError::new(format!(
                        "\"{}\" is not a PNG, JPG, GIF or WebP image.",
                        loaded.name
                    ))
                    .code("INVALID_ARGS")
                    .hint("Emoji images must be PNG, JPG, GIF or WebP.")
                    .into());
                };

                let roles = match a.strs("roles") {
                    Some(list) => Some(
                        futures::future::try_join_all(
                            list.iter()
                                .map(|r| ctx.resolver.role_id(r, &guild_id, true)),
                        )
                        .await?,
                    ),
                    None => None,
                };
                let image = format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&loaded.data)
                );
                let emoji = ctx
                    .rest
                    .post(
                        &format!("/guilds/{guild_id}/emojis"),
                        Some(obj! { "name" => name, "image" => image, "roles" => roles }),
                        reason.as_deref(),
                        vec![],
                    )
                    .await?;
                ctx.resolver.upsert_emoji(&guild_id, &emoji);
                Ok(Outcome::with(
                    format!(
                        "Added emoji :{}: ({}).",
                        crate::gateway::js_string(emoji.get("name")),
                        crate::gateway::js_string(emoji.get("id"))
                    ),
                    format_emoji(&emoji, None),
                ))
            }
            "rename" => {
                let (Some(emoji_ref), Some(name)) = (emoji_ref, name) else {
                    return Err(ToolError::new(
                        "`emoji` and `name` are required to rename an emoji.",
                    )
                    .code("MISSING_ARG")
                    .into());
                };
                let (eid, _) = emoji_of(&ctx, &guild_id, &emoji_ref).await?;
                let emoji = ctx
                    .rest
                    .patch(
                        &format!("/guilds/{guild_id}/emojis/{eid}"),
                        json!({ "name": name }),
                        reason.as_deref(),
                    )
                    .await?;
                ctx.resolver.upsert_emoji(&guild_id, &emoji);
                Ok(Outcome::with(
                    format!(
                        "Renamed emoji {eid} to :{}:.",
                        crate::gateway::js_string(emoji.get("name"))
                    ),
                    format_emoji(&emoji, None),
                ))
            }
            _ => {
                let Some(emoji_ref) = emoji_ref else {
                    return Err(ToolError::new("`emoji` is required to delete an emoji.")
                        .code("MISSING_ARG")
                        .into());
                };
                let (eid, ename) = emoji_of(&ctx, &guild_id, &emoji_ref).await?;
                ctx.rest
                    .delete(
                        &format!("/guilds/{guild_id}/emojis/{eid}"),
                        reason.as_deref(),
                    )
                    .await?;
                ctx.resolver.remove_emoji(&guild_id, &eid);
                Ok(Outcome::text(format!(
                    "Deleted emoji {eid}{}.",
                    ename.map(|n| format!(" (:{n}:)")).unwrap_or_default()
                )))
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

static INVITE_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{2,32}$").expect("valid regex"));
static INVITE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^(?:https?://)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com/invite)/([^/?#{}]+)",
        crate::js::JS_SPACE_CLASS
    ))
    .expect("valid regex")
});

/// A bare code, or the code from a discord.gg / discord.com/invite link.
fn invite_code(input: &str) -> Result<String> {
    let trimmed = crate::js::trim(input);
    let code = INVITE_LINK
        .captures(trimmed)
        .map_or_else(|| trimmed.to_string(), |c| c[1].to_string());
    if !INVITE_CODE.is_match(&code) {
        return Err(ToolError::new(format!("\"{input}\" is not a valid invite code or link."))
            .code("INVALID_ARGS")
            .hint("Pass the code (for example abc123) or a link such as https://discord.gg/abc123.")
            .into());
    }
    Ok(code)
}

fn format_invite(invite: &Value) -> Value {
    let code = s(invite, "code").unwrap_or("");
    let mut out = Map::new();
    out.insert("code".into(), code.into());
    out.insert("url".into(), format!("https://discord.gg/{code}").into());
    let channel = present(invite, "channel");
    if let Some(name) = channel
        .and_then(|c| present(c, "name").or_else(|| present(c, "id")))
        .filter(|v| crate::json::truthy(Some(v)))
    {
        out.insert("channel".into(), name.clone());
    }
    if let Some(inviter) = present(invite, "inviter") {
        crate::json::put(&mut out, "inviter", inviter.get("username").cloned());
    }
    // Absent fields stay absent, as JSON.stringify drops undefined.
    crate::json::put(&mut out, "uses", invite.get("uses").cloned());
    crate::json::put(&mut out, "max_uses", invite.get("max_uses").cloned());
    if let Some(e) = st(invite, "expires_at") {
        out.insert("expires_at".into(), e.into());
    }
    if b(invite, "temporary") {
        out.insert("temporary".into(), true.into());
    }
    // Keep the original's key order: code, url, uses, max_uses, then the optional fields.
    let order = [
        "code",
        "url",
        "uses",
        "max_uses",
        "channel",
        "inviter",
        "expires_at",
        "temporary",
    ];
    let mut ordered = Map::new();
    for k in order {
        if let Some(v) = out.remove(k) {
            ordered.insert(k.into(), v);
        }
    }
    Value::Object(ordered)
}

pub fn manage_invites() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Listing invites needs Manage Server. Revoking needs Manage Channels on the invite's channel.",
        ),
        ..ToolDef::new("discord_manage_invites", invites_handler)
    }
}

fn invites_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let action = a.str("action").unwrap_or_else(|| "list".into());
        if action == "revoke" && !ctx.config.allow_destructive {
            return Err(destructive_disabled("discord_manage_invites revoke"));
        }

        if action == "list" {
            let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
            let invites = ctx
                .rest
                .get(&format!("/guilds/{guild_id}/invites"), &[], None)
                .await?;
            let invites = invites.as_array().cloned().unwrap_or_default();
            return Ok(Outcome::with(
                format!("{} in server {guild_id}.", plural(invites.len(), "invite")),
                Value::Array(invites.iter().map(format_invite).collect()),
            ));
        }

        let Some(code) = a.str("code").filter(|c| !c.is_empty()) else {
            return Err(ToolError::new("`code` is required to revoke an invite.")
                .code("MISSING_ARG")
                .into());
        };
        let code = invite_code(&code)?;
        ctx.rest
            .delete(
                &format!("/invites/{}", crate::js::encode_uri_component(&code)),
                a.reason().as_deref(),
            )
            .await?;
        Ok(Outcome::text(format!(
            "Revoked invite https://discord.gg/{code}."
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_codes() {
        assert_eq!(invite_code("https://discord.gg/abc123").unwrap(), "abc123");
        assert_eq!(invite_code("discord.com/invite/xyz-9").unwrap(), "xyz-9");
        assert_eq!(invite_code(" abc ").unwrap(), "abc");
        assert!(invite_code("bad code!").is_err());
    }

    #[test]
    fn sampling() {
        let v: Vec<Value> = (0..12).map(|i| Value::from(i.to_string())).collect();
        let out = sampled(&v, Detail::Compact).unwrap();
        assert_eq!(out.len(), 11);
        assert_eq!(out[10], "and 2 more");
        assert_eq!(sampled(&v, Detail::Full).unwrap().len(), 12);
    }

    #[test]
    fn mime_from_name() {
        assert_eq!(image_mime("a.PNG", None), Some("image/png"));
        assert_eq!(image_mime("a.bin", Some("image/gif")), Some("image/gif"));
        assert_eq!(image_mime("a.txt", Some("text/plain")), None);
    }
}
