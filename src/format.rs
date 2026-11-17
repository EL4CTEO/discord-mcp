//! Compact renderings of Discord objects. Compact is the default everywhere.

use crate::js::clip;
use crate::json::{arr, b, i, present, s, st, truthy};
use crate::obj;
use crate::permissions::{bits_of, permission_names};
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Detail {
    Compact,
    Full,
}

impl Detail {
    pub fn parse(v: Option<&str>) -> Detail {
        if v == Some("full") {
            Detail::Full
        } else {
            Detail::Compact
        }
    }
}

pub const GUILD_TEXT: i64 = 0;
pub const GUILD_VOICE: i64 = 2;
pub const GUILD_CATEGORY: i64 = 4;
pub const GUILD_ANNOUNCEMENT: i64 = 5;
pub const ANNOUNCEMENT_THREAD: i64 = 10;
pub const PUBLIC_THREAD: i64 = 11;
pub const PRIVATE_THREAD: i64 = 12;
pub const GUILD_STAGE_VOICE: i64 = 13;
pub const GUILD_FORUM: i64 = 15;
pub const GUILD_MEDIA: i64 = 16;

pub fn channel_type_name(t: i64) -> String {
    match t {
        0 => "text",
        1 => "dm",
        2 => "voice",
        3 => "group_dm",
        4 => "category",
        5 => "announcement",
        10 => "announcement_thread",
        11 => "public_thread",
        12 => "private_thread",
        13 => "stage",
        14 => "directory",
        15 => "forum",
        16 => "media",
        _ => return format!("unknown({t})"),
    }
    .to_string()
}

pub fn is_thread_type(t: i64) -> bool {
    matches!(t, PUBLIC_THREAD | PRIVATE_THREAD | ANNOUNCEMENT_THREAD)
}

/// A channel's numeric type (-1 when absent).
pub fn ctype(channel: &Value) -> i64 {
    i(channel, "type").unwrap_or(-1)
}

const DISCORD_EPOCH: u64 = 1_420_070_400_000;

/// Discord snowflakes encode their creation time (ms since epoch) in the high bits.
pub fn snowflake_ms(id: &str) -> Option<i64> {
    let n: u128 = if id.is_empty() { 0 } else { id.parse().ok()? };
    i64::try_from((n >> 22) + u128::from(DISCORD_EPOCH)).ok()
}

pub fn snowflake_to_date(id: &str) -> Option<String> {
    snowflake_ms(id).map(crate::js::iso_from_ms)
}

pub fn format_user(user: &Value) -> Value {
    obj! {
        "id" => s(user, "id").unwrap_or(""),
        "username" => s(user, "username").unwrap_or(""),
        "display_name" => st(user, "global_name"),
        "bot" => b(user, "bot").then_some(true),
    }
}

/// Question and answers, with vote counts once Discord reports them.
pub fn format_poll(poll: &Value) -> Value {
    let results = present(poll, "results");
    let counts: Vec<(i64, i64)> = results
        .map(|r| {
            arr(r, "answer_counts")
                .iter()
                .map(|c| (i(c, "id").unwrap_or(0), i(c, "count").unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default();
    let answers: Vec<Value> = arr(poll, "answers")
        .iter()
        .map(|a| {
            let id = i(a, "answer_id").unwrap_or(0);
            let text = a.get("poll_media").and_then(|m| s(m, "text")).unwrap_or("");
            let votes = results.map(|_| {
                counts
                    .iter()
                    .find(|(cid, _)| *cid == id)
                    .map_or(0, |(_, n)| *n)
            });
            obj! { "id" => id, "text" => text, "votes" => votes }
        })
        .collect();

    obj! {
        "question" => poll.get("question").and_then(|q| s(q, "text")).unwrap_or(""),
        "answers" => answers,
        "expires_at" => poll.get("expiry").cloned(),
        "finalized" => results.map(|r| b(r, "is_finalized")),
    }
}

/// Embeds are where bots put their actual text. Compact keeps the headline;
/// full adds the fields. A fields-only embed keeps a few fields in compact mode.
fn format_embed(embed: &Value, detail: Detail) -> Value {
    let mut out = Map::new();
    if let Some(t) = st(embed, "title") {
        out.insert("title".into(), t.into());
    }
    if let Some(d) = st(embed, "description") {
        out.insert(
            "description".into(),
            clip(d, if detail == Detail::Full { 4096 } else { 300 }).into(),
        );
    }
    if let Some(u) = st(embed, "url") {
        out.insert("url".into(), u.into());
    }
    let fields = arr(embed, "fields");
    let field = |f: &Value, max: usize| obj! { "name" => s(f, "name").unwrap_or(""), "value" => clip(s(f, "value").unwrap_or(""), max) };
    if detail == Detail::Full && !fields.is_empty() {
        out.insert(
            "fields".into(),
            Value::Array(fields.iter().map(|f| field(f, 1024)).collect()),
        );
    } else if !b(embed, "title") && !b(embed, "description") && !fields.is_empty() {
        out.insert(
            "fields".into(),
            Value::Array(fields.iter().take(5).map(|f| field(f, 200)).collect()),
        );
    }
    Value::Object(out)
}

const MESSAGE_TYPES: &[(i64, &str)] = &[
    (0, "Default"),
    (1, "RecipientAdd"),
    (2, "RecipientRemove"),
    (3, "Call"),
    (4, "ChannelNameChange"),
    (5, "ChannelIconChange"),
    (6, "ChannelPinnedMessage"),
    (7, "UserJoin"),
    (8, "GuildBoost"),
    (9, "GuildBoostTier1"),
    (10, "GuildBoostTier2"),
    (11, "GuildBoostTier3"),
    (12, "ChannelFollowAdd"),
    (14, "GuildDiscoveryDisqualified"),
    (15, "GuildDiscoveryRequalified"),
    (16, "GuildDiscoveryGracePeriodInitialWarning"),
    (17, "GuildDiscoveryGracePeriodFinalWarning"),
    (18, "ThreadCreated"),
    (19, "Reply"),
    (20, "ChatInputCommand"),
    (21, "ThreadStarterMessage"),
    (22, "GuildInviteReminder"),
    (23, "ContextMenuCommand"),
    (24, "AutoModerationAction"),
    (25, "RoleSubscriptionPurchase"),
    (26, "InteractionPremiumUpsell"),
    (27, "StageStart"),
    (28, "StageEnd"),
    (29, "StageSpeaker"),
    (30, "StageRaiseHand"),
    (31, "StageTopic"),
    (32, "GuildApplicationPremiumSubscription"),
    (36, "GuildIncidentAlertModeEnabled"),
    (37, "GuildIncidentAlertModeDisabled"),
    (38, "GuildIncidentReportRaid"),
    (39, "GuildIncidentReportFalseAlarm"),
    (44, "PurchaseNotification"),
    (46, "PollResult"),
];

const FORWARD: i64 = 1;

fn is_forward(message: &Value) -> bool {
    present(message, "message_reference").and_then(|r| i(r, "type")) == Some(FORWARD)
}

/// The parts of a message that carry its text: for a forward, its snapshot.
struct Body<'a> {
    content: &'a str,
    attachments: &'a [Value],
    embeds: &'a [Value],
}

fn body_of(message: &Value) -> Body<'_> {
    let own = Body {
        content: s(message, "content").unwrap_or(""),
        attachments: arr(message, "attachments"),
        embeds: arr(message, "embeds"),
    };
    if !is_forward(message) {
        return own;
    }
    match arr(message, "message_snapshots")
        .first()
        .and_then(|snap| present(snap, "message"))
    {
        Some(snapshot) => Body {
            content: s(snapshot, "content").unwrap_or(""),
            attachments: arr(snapshot, "attachments"),
            embeds: arr(snapshot, "embeds"),
        },
        None => own,
    }
}

pub fn format_message(message: &Value, detail: Detail) -> Value {
    let body = body_of(message);
    let author = message.get("author").cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert("id".into(), s(message, "id").unwrap_or("").into());
    let author_name = s(&author, "global_name")
        .or_else(|| s(&author, "username"))
        .unwrap_or("");
    out.insert("author".into(), author_name.into());
    out.insert("author_id".into(), s(&author, "id").unwrap_or("").into());
    out.insert(
        "content".into(),
        clip(
            body.content,
            if detail == Detail::Full { 4000 } else { 500 },
        )
        .into(),
    );
    if let Some(ts) = message.get("timestamp") {
        out.insert("created_at".into(), ts.clone());
    }

    let t = i(message, "type").unwrap_or(0);
    if t != 0 && t != 19 {
        let name = MESSAGE_TYPES
            .iter()
            .find(|(n, _)| *n == t)
            .map_or_else(|| format!("type_{t}"), |(_, name)| (*name).to_string());
        out.insert("kind".into(), name.into());
    }
    if b(message, "edited_timestamp") {
        out.insert("edited".into(), true.into());
    }
    if b(message, "pinned") {
        out.insert("pinned".into(), true.into());
    }

    if let Some(reference) = present(message, "message_reference") {
        if i(reference, "type") == Some(FORWARD) {
            out.insert("forwarded".into(), true.into());
            out.insert(
                "forwarded_from".into(),
                obj! { "channel_id" => reference.get("channel_id").cloned(), "message_id" => reference.get("message_id").cloned() },
            );
        } else if let Some(id) = st(reference, "message_id") {
            out.insert("reply_to".into(), id.into());
        }
    }
    if let Some(id) = present(message, "thread").and_then(|t| st(t, "id")) {
        out.insert("thread_id".into(), id.into());
    }

    if !body.attachments.is_empty() {
        let list: Vec<Value> = body
            .attachments
            .iter()
            .map(|a| obj! { "name" => a.get("filename").cloned(), "url" => a.get("url").cloned(), "size" => a.get("size").cloned() })
            .collect();
        out.insert("attachments".into(), list.into());
    }
    if !body.embeds.is_empty() {
        out.insert(
            "embeds".into(),
            body.embeds
                .iter()
                .map(|e| format_embed(e, detail))
                .collect::<Vec<_>>()
                .into(),
        );
    }
    if let Some(poll) = present(message, "poll") {
        out.insert("poll".into(), format_poll(poll));
    }
    let reactions = arr(message, "reactions");
    if !reactions.is_empty() {
        let list: Vec<Value> = reactions
            .iter()
            .map(|r| {
                let emoji = r.get("emoji").cloned().unwrap_or(Value::Null);
                let name = present(&emoji, "name")
                    .or_else(|| present(&emoji, "id"))
                    .cloned()
                    .unwrap_or_else(|| "?".into());
                obj! { "emoji" => name, "count" => r.get("count").cloned() }
            })
            .collect();
        out.insert("reactions".into(), list.into());
    }

    Value::Object(out)
}

pub fn format_channel(channel: &Value, detail: Detail) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), s(channel, "id").unwrap_or("").into());
    out.insert(
        "name".into(),
        st(channel, "name").unwrap_or("(unnamed)").into(),
    );
    out.insert("type".into(), channel_type_name(ctype(channel)).into());
    if let Some(p) = st(channel, "parent_id") {
        out.insert("parent_id".into(), p.into());
    }
    if let Some(topic) = st(channel, "topic") {
        out.insert(
            "topic".into(),
            clip(topic, if detail == Detail::Full { 1024 } else { 200 }).into(),
        );
    }
    if b(channel, "nsfw") {
        out.insert("nsfw".into(), true.into());
    }
    if truthy(channel.get("rate_limit_per_user")) {
        out.insert(
            "slowmode_seconds".into(),
            channel["rate_limit_per_user"].clone(),
        );
    }
    if let Some(meta) = present(channel, "thread_metadata") {
        if b(meta, "archived") {
            out.insert("archived".into(), true.into());
        }
        if b(meta, "locked") {
            out.insert("locked".into(), true.into());
        }
    }
    if detail == Detail::Full
        && let Some(p) = channel.get("position").filter(|p| p.is_number())
    {
        out.insert("position".into(), p.clone());
    }
    Value::Object(out)
}

fn hex(colour: i64) -> String {
    format!("#{colour:06x}")
}

pub fn format_role(role: &Value, detail: Detail) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), s(role, "id").unwrap_or("").into());
    out.insert("name".into(), s(role, "name").unwrap_or("").into());
    out.insert(
        "position".into(),
        role.get("position").cloned().unwrap_or(Value::from(0)),
    );
    let colors = present(role, "colors");
    let primary = colors
        .and_then(|c| present(c, "primary_color"))
        .or_else(|| role.get("color"));
    if truthy(primary)
        && let Some(p) = primary.and_then(Value::as_i64)
    {
        out.insert("color".into(), hex(p).into());
    }
    if let Some(sec) = colors
        .and_then(|c| c.get("secondary_color"))
        .filter(|v| truthy(Some(v)))
        .and_then(Value::as_i64)
    {
        out.insert("secondary_color".into(), hex(sec).into());
    }
    if b(role, "hoist") {
        out.insert("hoisted".into(), true.into());
    }
    if b(role, "mentionable") {
        out.insert("mentionable".into(), true.into());
    }
    if b(role, "managed") {
        out.insert("managed".into(), true.into());
    }
    if detail == Detail::Full {
        let bits = role.get("permissions").and_then(bits_of);
        out.insert(
            "permissions".into(),
            bits.map(permission_names).unwrap_or_default().into(),
        );
    }
    Value::Object(out)
}

/// `role_names` maps role id -> name so the agent sees "Moderator" instead of a snowflake.
pub fn format_member(member: &Value, role_names: Option<&[(String, String)]>) -> Value {
    let user = member.get("user").cloned().unwrap_or(Value::Null);
    let username = s(&user, "username").unwrap_or("");
    let display = s(member, "nick")
        .or_else(|| s(&user, "global_name"))
        .unwrap_or(username);
    let roles: Vec<Value> = arr(member, "roles")
        .iter()
        .filter_map(Value::as_str)
        .map(|id| {
            role_names
                .and_then(|names| names.iter().find(|(rid, _)| rid == id))
                .map_or(id, |(_, n)| n.as_str())
                .into()
        })
        .collect();

    let mut out = Map::new();
    out.insert("id".into(), s(&user, "id").unwrap_or("").into());
    out.insert("username".into(), username.into());
    out.insert("display_name".into(), display.into());
    out.insert("roles".into(), roles.into());
    if let Some(nick) = st(member, "nick") {
        out.insert("nickname".into(), nick.into());
    }
    if b(&user, "bot") {
        out.insert("bot".into(), true.into());
    }
    if let Some(j) = st(member, "joined_at") {
        out.insert("joined_at".into(), j.into());
    }
    if let Some(until) = st(member, "communication_disabled_until")
        && crate::js::parse_date_ms(until) > crate::js::now_ms() as f64
    {
        out.insert("timed_out_until".into(), until.into());
    }
    Value::Object(out)
}

pub fn format_guild(guild: &Value, detail: Detail) -> Value {
    let id = s(guild, "id").unwrap_or("");
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("name".into(), s(guild, "name").unwrap_or("").into());
    if let Some(d) = st(guild, "description") {
        out.insert("description".into(), d.into());
    }
    if let Some(o) = st(guild, "owner_id") {
        out.insert("owner_id".into(), o.into());
    }
    if let Some(n) = guild
        .get("approximate_member_count")
        .filter(|n| n.is_number())
    {
        out.insert("member_count".into(), n.clone());
    }
    if detail == Detail::Full {
        if let Some(created) = snowflake_to_date(id) {
            out.insert("created_at".into(), created.into());
        }
        let features = arr(guild, "features");
        if !features.is_empty() {
            out.insert("features".into(), features.to_vec().into());
        }
    }
    Value::Object(out)
}

/// Everything a text search should look at: the content plus embed text.
pub fn searchable_text(message: &Value) -> String {
    let body = body_of(message);
    if body.embeds.is_empty() {
        return body.content.to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    for e in body.embeds {
        parts.extend(st(e, "title"));
        parts.extend(st(e, "description"));
        for f in arr(e, "fields") {
            parts.extend(st(f, "name"));
            parts.extend(st(f, "value"));
        }
    }
    format!("{}\n{}", body.content, parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_compact() {
        let m = json!({
            "id": "1", "type": 19, "content": "hi", "timestamp": "2026-01-01T00:00:00.000000+00:00",
            "author": {"id": "2", "username": "bob", "global_name": null},
            "attachments": [], "embeds": [], "pinned": false, "edited_timestamp": null,
            "message_reference": {"message_id": "9"}
        });
        assert_eq!(
            crate::js::stringify(&format_message(&m, Detail::Compact)),
            r#"{"id":"1","author":"bob","author_id":"2","content":"hi","created_at":"2026-01-01T00:00:00.000000+00:00","reply_to":"9"}"#
        );
    }

    #[test]
    fn forwarded_message_uses_snapshot() {
        let m = json!({
            "id": "1", "type": 0, "content": "", "timestamp": "t", "author": {"id": "2", "username": "bob"},
            "attachments": [], "embeds": [],
            "message_reference": {"type": 1, "channel_id": "5", "message_id": "6"},
            "message_snapshots": [{"message": {"content": "original"}}]
        });
        let out = format_message(&m, Detail::Compact);
        assert_eq!(out["content"], "original");
        assert_eq!(out["forwarded"], true);
        assert_eq!(
            out["forwarded_from"],
            json!({"channel_id": "5", "message_id": "6"})
        );
    }

    #[test]
    fn role_colours() {
        let r = json!({"id": "1", "name": "A", "position": 3, "color": 0, "colors": {"primary_color": 5793266, "secondary_color": null}, "permissions": "8"});
        let out = format_role(&r, Detail::Full);
        assert_eq!(out["color"], "#5865f2");
        assert_eq!(out["permissions"], json!(["Administrator"]));
    }

    #[test]
    fn snowflake_dates() {
        assert_eq!(
            snowflake_to_date("175928847299117063").unwrap(),
            "2016-04-30T11:18:25.796Z"
        );
    }

    #[test]
    fn member_roles_by_name() {
        let m = json!({"user": {"id": "1", "username": "u"}, "nick": "N", "roles": ["10", "11"], "joined_at": "j"});
        let names = vec![("10".to_string(), "Mod".to_string())];
        let out = format_member(&m, Some(&names));
        assert_eq!(
            crate::js::stringify(&out),
            r#"{"id":"1","username":"u","display_name":"N","roles":["Mod","11"],"nickname":"N","joined_at":"j"}"#
        );
    }
}
