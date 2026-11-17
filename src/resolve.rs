//! Turns human-friendly references into Discord IDs.
//!
//! Every tool takes names or IDs interchangeably, so the agent never has to
//! run a lookup tool first. Listings are cached, and kept current in place:
//! tools fold their own creates, edits and deletes into the cache, and while
//! the gateway is open its channel and role events do the same.

use crate::cache::TtlCache;
use crate::config::Config;
use crate::errors::{Error, Result, ToolError};
use crate::format::{channel_type_name, ctype, is_thread_type};
use crate::json::{arr, id, s};
use crate::rest::{Rest, q};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

static SNOWFLAKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{17,20}$").expect("valid regex"));
/// Captures the sigil (@ or #), the optional modifier (! or &) and the ID.
static MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<([@#])(!|&)?([0-9]{17,20})>$").expect("valid regex"));
static EVERYONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^@?everyone$").expect("valid regex"));
static LOOSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("[{}_-]+", crate::js::JS_SPACE_CLASS)).expect("valid regex")
});

/// Discord caps GET /users/@me/guilds at 200 per page.
const GUILD_PAGE: usize = 200;
/// Member search page; a full page is a useful "too many matches" signal.
const MEMBER_SEARCH_LIMIT: usize = 100;

pub type List = Arc<Vec<Value>>;

/// True when the string is already a Discord ID (an unsigned 64-bit snowflake).
pub fn is_snowflake(value: &str) -> bool {
    SNOWFLAKE.is_match(value) && value.parse::<u64>().is_ok()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum MentionKind {
    User,
    Role,
    Channel,
}

impl MentionKind {
    fn name(self) -> &'static str {
        match self {
            MentionKind::User => "user",
            MentionKind::Role => "role",
            MentionKind::Channel => "channel",
        }
    }
}

struct ParsedRef {
    id: Option<String>,
    name: String,
    mention: Option<MentionKind>,
}

/// Accepts a raw ID, a mention (`<#123>`) or a decorated name (`#general`, `@Mods`).
fn parse_ref(input: &str) -> ParsedRef {
    let trimmed = crate::js::trim(input);
    if let Some(c) = MENTION.captures(trimmed) {
        let id = &c[3];
        if is_snowflake(id) {
            let kind = if &c[1] == "#" {
                MentionKind::Channel
            } else if c.get(2).is_some_and(|m| m.as_str() == "&") {
                MentionKind::Role
            } else {
                MentionKind::User
            };
            return ParsedRef {
                id: Some(id.to_string()),
                name: trimmed.to_string(),
                mention: Some(kind),
            };
        }
    }
    if is_snowflake(trimmed) {
        return ParsedRef {
            id: Some(trimmed.to_string()),
            name: trimmed.to_string(),
            mention: None,
        };
    }
    let stripped = trimmed.strip_prefix(['#', '@']).unwrap_or(trimmed);
    ParsedRef {
        id: None,
        name: crate::js::trim(stripped).to_string(),
        mention: None,
    }
}

/// Case/format-insensitive comparison: "Breakout Block" == "breakout-block".
pub fn normalize(value: &str) -> String {
    LOOSE.replace_all(&value.to_lowercase(), "").into_owned()
}

#[derive(Clone, Debug)]
pub struct Named {
    pub id: String,
    pub name: String,
    /// Extra detail shown only in ambiguity errors, e.g. a channel type.
    pub detail: Option<String>,
}

fn not_found(candidates: &[Named], query: &str, kind: &str, exact: bool) -> Error {
    let available = candidates
        .iter()
        .take(25)
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let list = if available.is_empty() {
        format!("The bot can see no {kind}s here.")
    } else {
        format!("Available {kind}s: {available}")
    };
    ToolError::new(format!("No {kind} named \"{query}\" was found."))
        .code("NOT_FOUND")
        .hint(if exact {
            format!("Destructive actions need the exact name or the ID. {list}")
        } else {
            list
        })
        .into()
}

fn ambiguous(query: &str, kind: &str, pool: &[Named]) -> Error {
    let names = pool
        .iter()
        .take(15)
        .map(|c| match &c.detail {
            Some(d) => format!("{} ({d}, {})", c.name, c.id),
            None => format!("{} ({})", c.name, c.id),
        })
        .collect::<Vec<_>>()
        .join(", ");
    ToolError::new(format!(
        "\"{query}\" matches {} {kind}s, so it is ambiguous.",
        pool.len()
    ))
    .code("AMBIGUOUS")
    .hint(format!("Pass the exact name or the ID. Matches: {names}"))
    .into()
}

/// Picks the single best match, or fails with a message listing the real options.
/// With `exact`, only the literal or normalised name can select a candidate.
pub fn pick_one(candidates: &[Named], query: &str, kind: &str, exact: bool) -> Result<Named> {
    let q = crate::js::trim(query);
    let target = normalize(q);
    if target.is_empty() {
        return Err(not_found(candidates, query, kind, exact));
    }

    let literal: Vec<&Named> = candidates.iter().filter(|c| c.name == q).collect();
    if literal.len() == 1 {
        return Ok(literal[0].clone());
    }
    let exact_pool: Vec<Named> = candidates
        .iter()
        .filter(|c| normalize(&c.name) == target)
        .cloned()
        .collect();
    if exact_pool.len() == 1 {
        return Ok(exact_pool[0].clone());
    }

    let mut pool = exact_pool;
    if pool.is_empty() && !exact {
        pool = candidates
            .iter()
            .filter(|c| normalize(&c.name).contains(&target))
            .cloned()
            .collect();
    }
    match pool.len() {
        1 => Ok(pool[0].clone()),
        0 => Err(not_found(candidates, query, kind, exact)),
        _ => Err(ambiguous(query, kind, &pool)),
    }
}

fn named_channels(channels: &[Value]) -> Vec<Named> {
    channels
        .iter()
        .filter_map(|c| {
            let name = s(c, "name").filter(|n| !n.is_empty())?;
            Some(Named {
                id: id(c).to_string(),
                name: name.to_string(),
                detail: Some(channel_type_name(ctype(c))),
            })
        })
        .collect()
}

/// A member as a pick candidate, showing the username when the name is something else.
fn member_named(member: &Value, name: &str) -> Named {
    let user = member.get("user").cloned().unwrap_or(Value::Null);
    let username = s(&user, "username").unwrap_or("");
    Named {
        id: id(&user).to_string(),
        name: name.to_string(),
        detail: if name == username {
            None
        } else {
            Some(format!("@{username}"))
        },
    }
}

fn display_name(member: &Value) -> String {
    let user = member.get("user").cloned().unwrap_or(Value::Null);
    s(member, "nick")
        .or_else(|| s(&user, "global_name"))
        .or_else(|| s(&user, "username"))
        .unwrap_or("")
        .to_string()
}

type DmOpen = Shared<BoxFuture<'static, Result<String>>>;

pub struct Resolver {
    rest: Arc<Rest>,
    config: Arc<Config>,
    guilds: TtlCache<List>,
    channels: TtlCache<List>,
    roles: TtlCache<List>,
    emojis: TtlCache<List>,
    threads: TtlCache<List>,
    /// Channels never move between servers, so this map is never invalidated.
    channel_guild: Arc<Mutex<HashMap<String, Option<String>>>>,
    dm_channels: Arc<Mutex<HashMap<String, DmOpen>>>,
    self_user: Mutex<Option<Value>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Resolver {
    pub fn new(rest: Arc<Rest>, config: Arc<Config>) -> Self {
        Self {
            rest,
            config,
            // Five minutes: every change made through this server is written straight into the cache.
            guilds: TtlCache::new(300_000, 4),
            channels: TtlCache::new(300_000, 32),
            roles: TtlCache::new(300_000, 32),
            emojis: TtlCache::new(300_000, 32),
            // Active threads come and go quickly, so they get a much shorter life.
            threads: TtlCache::new(30_000, 32),
            channel_guild: Arc::new(Mutex::new(HashMap::new())),
            dm_channels: Arc::new(Mutex::new(HashMap::new())),
            self_user: Mutex::new(None),
        }
    }

    /// The bot's own user, cached for the process lifetime once it succeeds.
    pub async fn self_user(&self) -> Result<Value> {
        if let Some(user) = lock(&self.self_user).clone() {
            return Ok(user);
        }
        let user = self.rest.get("/users/@me", &[], None).await?;
        *lock(&self.self_user) = Some(user.clone());
        Ok(user)
    }

    pub async fn self_id(&self) -> Result<String> {
        Ok(id(&self.self_user().await?).to_string())
    }

    /// Every guild the bot is a member of, following pagination past 200.
    pub async fn guilds(&self) -> Result<List> {
        let rest = Arc::clone(&self.rest);
        self.guilds
            .fetch("all", move || async move {
                let mut all = Vec::new();
                let mut after: Option<String> = None;
                loop {
                    let page = rest
                        .get(
                            "/users/@me/guilds",
                            &[
                                ("limit", q(GUILD_PAGE)),
                                ("with_counts", q(true)),
                                ("after", after.clone()),
                            ],
                            None,
                        )
                        .await?;
                    let page = page.as_array().cloned().unwrap_or_default();
                    let n = page.len();
                    after = page.last().map(|g| id(g).to_string());
                    all.extend(page);
                    if n < GUILD_PAGE {
                        return Ok(Arc::new(all));
                    }
                }
            })
            .await
    }

    pub async fn channels(&self, guild_id: &str) -> Result<List> {
        let rest = Arc::clone(&self.rest);
        let map = Arc::clone(&self.channel_guild);
        let gid = guild_id.to_string();
        self.channels
            .fetch(guild_id, move || async move {
                let channels = rest
                    .get(&format!("/guilds/{gid}/channels"), &[], None)
                    .await?;
                let channels = channels.as_array().cloned().unwrap_or_default();
                let mut m = lock(&map);
                for c in &channels {
                    m.insert(id(c).to_string(), Some(gid.clone()));
                }
                Ok(Arc::new(channels))
            })
            .await
    }

    pub async fn roles(&self, guild_id: &str) -> Result<List> {
        let rest = Arc::clone(&self.rest);
        let route = format!("/guilds/{guild_id}/roles");
        self.roles
            .fetch(guild_id, move || async move {
                Ok(Arc::new(
                    rest.get(&route, &[], None)
                        .await?
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                ))
            })
            .await
    }

    pub async fn emojis(&self, guild_id: &str) -> Result<List> {
        let rest = Arc::clone(&self.rest);
        let route = format!("/guilds/{guild_id}/emojis");
        self.emojis
            .fetch(guild_id, move || async move {
                Ok(Arc::new(
                    rest.get(&route, &[], None)
                        .await?
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                ))
            })
            .await
    }

    /// Active threads in a guild. Not part of the channel listing, so fetched separately.
    pub async fn threads(&self, guild_id: &str) -> Result<List> {
        let rest = Arc::clone(&self.rest);
        let map = Arc::clone(&self.channel_guild);
        let gid = guild_id.to_string();
        self.threads
            .fetch(guild_id, move || async move {
                let active = rest
                    .get(&format!("/guilds/{gid}/threads/active"), &[], None)
                    .await?;
                let threads = arr(&active, "threads").to_vec();
                let mut m = lock(&map);
                for t in &threads {
                    m.insert(id(t).to_string(), Some(gid.clone()));
                }
                Ok(Arc::new(threads))
            })
            .await
    }

    /// role id -> role name, so member listings show names instead of snowflakes.
    pub async fn role_names(&self, guild_id: &str) -> Result<Vec<(String, String)>> {
        let roles = self.roles(guild_id).await?;
        Ok(roles
            .iter()
            .map(|r| (id(r).to_string(), s(r, "name").unwrap_or("").to_string()))
            .collect())
    }

    /// A channel from the cached listing, or None if it is not a top-level channel.
    pub async fn find_channel(&self, guild_id: &str, channel_id: &str) -> Result<Option<Value>> {
        Ok(self
            .channels(guild_id)
            .await?
            .iter()
            .find(|c| id(c) == channel_id)
            .cloned())
    }

    /// Resolves the target server: the input, else DISCORD_DEFAULT_GUILD, else the only server the bot is in.
    pub async fn guild_id(&self, input: Option<&str>) -> Result<String> {
        let value = input
            .map(str::to_string)
            .or_else(|| self.config.default_guild.clone())
            .filter(|v| !v.is_empty());

        if let Some(value) = value {
            let r = parse_ref(&value);
            if let Some(id) = r.id {
                return Ok(id);
            }
            let guilds = self.guilds().await?;
            let named: Vec<Named> = guilds
                .iter()
                .map(|g| Named {
                    id: id(g).to_string(),
                    name: s(g, "name").unwrap_or("").to_string(),
                    detail: None,
                })
                .collect();
            return Ok(pick_one(&named, &r.name, "server", false)?.id);
        }

        let guilds = self.guilds().await?;
        if guilds.len() == 1 {
            return Ok(id(&guilds[0]).to_string());
        }
        if guilds.is_empty() {
            return Err(ToolError::new("The bot is not in any server yet.")
                .code("NO_GUILDS")
                .hint("Invite it with the OAuth2 URL from the Discord Developer Portal (scopes: bot, applications.commands).")
                .into());
        }
        let names = guilds
            .iter()
            .map(|g| s(g, "name").unwrap_or(""))
            .collect::<Vec<_>>()
            .join(", ");
        Err(
            ToolError::new("The bot is in several servers, so `guild` is required.")
                .code("GUILD_REQUIRED")
                .hint(format!("Pass guild as a name or ID. Options: {names}"))
                .into(),
        )
    }

    /// The server a channel ID belongs to, or None for a DM.
    pub async fn channel_guild_id(&self, channel_id: &str) -> Result<Option<String>> {
        if let Some(known) = lock(&self.channel_guild).get(channel_id) {
            return Ok(known.clone());
        }
        let channel = self
            .rest
            .get(&format!("/channels/{channel_id}"), &[], None)
            .await?;
        let guild = s(&channel, "guild_id")
            .filter(|g| !g.is_empty())
            .map(str::to_string);
        lock(&self.channel_guild).insert(channel_id.to_string(), guild.clone());
        Ok(guild)
    }

    /// Resolves a channel or thread within a guild. Active threads are only
    /// fetched when no channel matches exactly, and then compete in one pick.
    pub async fn channel_id(&self, input: &str, guild_id: &str, exact: bool) -> Result<String> {
        let r = parse_ref(input);
        if let Some(kind) = r.mention.filter(|k| *k != MentionKind::Channel) {
            return Err(ToolError::new(format!(
                "That is a {} mention, not a channel.",
                kind.name()
            ))
            .code("INVALID_ARGS")
            .hint("Pass a channel name, #name, or the channel ID.")
            .into());
        }
        if let Some(cid) = r.id {
            // Only a channel already known to live elsewhere is refused.
            if let Some(Some(known)) = lock(&self.channel_guild).get(&cid)
                && known != guild_id
            {
                return Err(
                    ToolError::new("That channel belongs to a different server.")
                        .code("WRONG_GUILD")
                        .hint("Pass the server that contains this channel, or omit guild.")
                        .into(),
                );
            }
            return Ok(cid);
        }

        let channels = named_channels(&self.channels(guild_id).await?);
        let target = normalize(&r.name);
        let has_exact = channels
            .iter()
            .any(|c| c.name == r.name || normalize(&c.name) == target);
        if has_exact {
            return Ok(pick_one(&channels, &r.name, "channel", exact)?.id);
        }

        // A thread listing failure should not hide the channels that were found.
        let threads = self
            .threads(guild_id)
            .await
            .map(|t| named_channels(&t))
            .unwrap_or_default();
        let mut all = channels;
        all.extend(threads);
        Ok(pick_one(&all, &r.name, "channel", exact)?.id)
    }

    /// Resolves a role. `@everyone` maps to the guild's own ID, as Discord defines it.
    pub async fn role_id(&self, input: &str, guild_id: &str, exact: bool) -> Result<String> {
        if EVERYONE.is_match(crate::js::trim(input)) {
            return Ok(guild_id.to_string());
        }
        let r = parse_ref(input);
        if let Some(kind) = r.mention.filter(|k| *k != MentionKind::Role) {
            return Err(
                ToolError::new(format!("That is a {} mention, not a role.", kind.name()))
                    .code("INVALID_ARGS")
                    .hint("Pass a role name, @role, or the role ID.")
                    .into(),
            );
        }
        if let Some(rid) = r.id {
            return Ok(rid);
        }
        let roles = self.roles(guild_id).await?;
        let named: Vec<Named> = roles
            .iter()
            .map(|r| Named {
                id: id(r).to_string(),
                name: s(r, "name").unwrap_or("").to_string(),
                detail: None,
            })
            .collect();
        Ok(pick_one(&named, &r.name, "role", exact)?.id)
    }

    /// Resolves a member by ID, username, nickname or display name through
    /// Discord's member search. Names are never cached: a stale name -> ID entry
    /// could make a ban hit the wrong person.
    pub async fn member(
        &self,
        input: &str,
        guild_id: &str,
        exact: bool,
    ) -> Result<(String, Option<Value>)> {
        let r = parse_ref(input);
        if r.mention.is_some_and(|k| k != MentionKind::User) {
            return Err(
                ToolError::new("That is a role/channel mention, not a member.")
                    .code("INVALID_ARGS")
                    .hint("Pass a member name, @name, or the user ID.")
                    .into(),
            );
        }
        if let Some(uid) = r.id {
            return Ok((uid, None));
        }

        let query = r.name.clone();
        let target = normalize(&query);
        if target.is_empty() {
            return Err(ToolError::new(format!(
                "No member named \"{}\" was found.",
                crate::js::trim(input)
            ))
            .code("NOT_FOUND")
            .hint("Pass a name or the user ID.")
            .into());
        }

        let matches = self
            .rest
            .get(
                &format!("/guilds/{guild_id}/members/search"),
                &[("query", q(&query)), ("limit", q(MEMBER_SEARCH_LIMIT))],
                None,
            )
            .await?;
        let matches = matches.as_array().cloned().unwrap_or_default();
        let found = |uid: &str| -> (String, Option<Value>) {
            let member = matches
                .iter()
                .find(|m| m.get("user").map(id) == Some(uid))
                .cloned();
            (uid.to_string(), member)
        };

        let exact_hits: Vec<&Value> = matches
            .iter()
            .filter(|m| {
                let user = m.get("user").cloned().unwrap_or(Value::Null);
                [s(&user, "username"), s(&user, "global_name"), s(m, "nick")]
                    .iter()
                    .flatten()
                    .any(|n| normalize(n) == target)
            })
            .collect();
        if exact_hits.len() == 1 {
            return Ok(found(exact_hits[0].get("user").map_or("", id)));
        }
        if exact_hits.len() > 1 {
            let pool: Vec<Named> = exact_hits
                .iter()
                .map(|m| member_named(m, &display_name(m)))
                .collect();
            return Err(ambiguous(&query, "member", &pool));
        }

        // A full page means the real set may hold the exact name too, so a partial pick would be a guess.
        if matches.len() >= MEMBER_SEARCH_LIMIT {
            return Err(ToolError::new(format!(
                "\"{query}\" matches too many members to choose one."
            ))
            .code("AMBIGUOUS")
            .hint("Too many members match; type more of the name or pass the ID.")
            .into());
        }

        if exact {
            return Err(
                ToolError::new(format!("No member named \"{query}\" was found."))
                    .code("NOT_FOUND")
                    .hint("Destructive actions need the exact name or the ID.")
                    .into(),
            );
        }

        let display: Vec<Named> = matches
            .iter()
            .map(|m| member_named(m, &display_name(m)))
            .collect();
        match pick_one(&display, &query, "member", false) {
            Ok(n) => return Ok(found(&n.id)),
            Err(e) if !e.is("NOT_FOUND") => return Err(e),
            Err(_) => {}
        }

        // A nickname can hide the username that was searched for.
        let usernames: Vec<Named> = matches
            .iter()
            .map(|m| {
                member_named(
                    m,
                    s(m.get("user").unwrap_or(&Value::Null), "username").unwrap_or(""),
                )
            })
            .collect();
        match pick_one(&usernames, &query, "member", false) {
            Ok(n) => Ok(found(&n.id)),
            Err(e) if !e.is("NOT_FOUND") => Err(e),
            Err(_) => Err(ToolError::new(format!("No member named \"{query}\" was found."))
                .code("NOT_FOUND")
                .hint(
                    "Search matches the start of a username or nickname. Try discord_list_members with a shorter \
                     query, or pass the user ID.",
                )
                .into()),
        }
    }

    pub async fn member_id(&self, input: &str, guild_id: &str, exact: bool) -> Result<String> {
        Ok(self.member(input, guild_id, exact).await?.0)
    }

    /// The DM channel with a user, opened once and remembered.
    pub async fn dm_channel(&self, user_id: &str) -> Result<String> {
        let pending = {
            let mut map = lock(&self.dm_channels);
            if let Some(p) = map.get(user_id) {
                p.clone()
            } else {
                let rest = Arc::clone(&self.rest);
                let channel_guild = Arc::clone(&self.channel_guild);
                let dms = Arc::clone(&self.dm_channels);
                let uid = user_id.to_string();
                let task = tokio::spawn(async move {
                    let result = rest
                        .post(
                            "/users/@me/channels",
                            Some(json!({ "recipient_id": uid })),
                            None,
                            vec![],
                        )
                        .await;
                    match result {
                        Ok(channel) => {
                            let cid = id(&channel).to_string();
                            lock(&channel_guild).insert(cid.clone(), None);
                            Ok(cid)
                        }
                        Err(e) => {
                            // Forget a failed attempt, so a transient error is not pinned for the process lifetime.
                            lock(&dms).remove(&uid);
                            Err(e)
                        }
                    }
                });
                let shared: DmOpen = async move {
                    task.await
                        .unwrap_or_else(|e| Err(Error::Other(e.to_string())))
                }
                .boxed()
                .shared();
                map.insert(user_id.to_string(), shared.clone());
                shared
            }
        };
        pending.await
    }

    /// Pre-loads the listings the first tool call would otherwise block on.
    /// Failures are ignored: the first real call reports them properly.
    pub async fn warm(&self) {
        let (guild, me) = tokio::join!(self.guild_id(None), self.self_user());
        if let (Ok(guild), Ok(_)) = (guild, me) {
            let _ = tokio::join!(self.channels(&guild), self.roles(&guild));
        }
    }

    // --- Cache maintenance --------------------------------------------------

    pub fn upsert_channel(&self, guild_id: &str, channel: &Value) {
        lock(&self.channel_guild).insert(id(channel).to_string(), Some(guild_id.to_string()));
        // Threads live in their own listing.
        if is_thread_type(ctype(channel)) {
            self.threads.delete(guild_id);
            return;
        }
        let channel = channel.clone();
        self.channels
            .update(guild_id, |list| Arc::new(upsert(list, &channel)));
    }

    pub fn remove_channel(&self, guild_id: &str, channel_id: &str) {
        self.channels.update(guild_id, |list| {
            Arc::new(
                list.iter()
                    .filter(|c| id(c) != channel_id)
                    .cloned()
                    .collect(),
            )
        });
        self.threads.update(guild_id, |list| {
            Arc::new(
                list.iter()
                    .filter(|c| id(c) != channel_id)
                    .cloned()
                    .collect(),
            )
        });
    }

    pub fn upsert_role(&self, guild_id: &str, role: &Value) {
        let role = role.clone();
        self.roles
            .update(guild_id, |list| Arc::new(upsert(list, &role)));
    }

    pub fn remove_role(&self, guild_id: &str, role_id: &str) {
        self.roles.update(guild_id, |list| {
            Arc::new(list.iter().filter(|r| id(r) != role_id).cloned().collect())
        });
    }

    pub fn upsert_emoji(&self, guild_id: &str, emoji: &Value) {
        let emoji = emoji.clone();
        self.emojis
            .update(guild_id, |list| Arc::new(upsert(list, &emoji)));
    }

    pub fn remove_emoji(&self, guild_id: &str, emoji_id: &str) {
        self.emojis.update(guild_id, |list| {
            Arc::new(list.iter().filter(|e| id(e) != emoji_id).cloned().collect())
        });
    }

    /// Replaces the whole role listing, e.g. with the result of a reorder.
    pub fn set_roles(&self, guild_id: &str, roles: Vec<Value>) {
        self.roles.set(guild_id, Arc::new(roles));
    }

    /// Drops a guild's channel listing when a change cannot be folded in.
    pub fn invalidate_channels(&self, guild_id: &str) {
        self.channels.delete(guild_id);
        self.threads.delete(guild_id);
    }

    pub fn invalidate_threads(&self, guild_id: &str) {
        self.threads.delete(guild_id);
    }

    pub fn invalidate(&self, guild_id: &str) {
        self.channels.delete(guild_id);
        self.roles.delete(guild_id);
        self.threads.delete(guild_id);
        self.emojis.delete(guild_id);
    }

    /// Keeps the caches current from live gateway traffic while it is connected.
    pub fn apply_dispatch(&self, t: &str, d: &Value) {
        match t {
            "GUILD_CREATE" => {
                // A newly joined server is missing from the cached guild list until it is refetched.
                self.guilds.clear();
                if d.get("unavailable").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                let gid = id(d).to_string();
                if let Some(channels) = d.get("channels").and_then(Value::as_array) {
                    let mut m = lock(&self.channel_guild);
                    for c in channels {
                        m.insert(id(c).to_string(), Some(gid.clone()));
                    }
                    drop(m);
                    self.channels.set(&gid, Arc::new(channels.clone()));
                }
                if let Some(roles) = d.get("roles").and_then(Value::as_array) {
                    self.roles.set(&gid, Arc::new(roles.clone()));
                }
            }
            "GUILD_DELETE" => {
                self.guilds.clear();
                self.invalidate(id(d));
            }
            "GUILD_UPDATE" => self.guilds.clear(),
            "CHANNEL_CREATE" | "CHANNEL_UPDATE" => {
                if let Some(g) = s(d, "guild_id").filter(|g| !g.is_empty()) {
                    self.upsert_channel(g, d);
                }
            }
            "CHANNEL_DELETE" => {
                if let Some(g) = s(d, "guild_id").filter(|g| !g.is_empty()) {
                    self.remove_channel(g, id(d));
                }
            }
            "THREAD_CREATE" | "THREAD_UPDATE" | "THREAD_DELETE" | "THREAD_LIST_SYNC" => {
                if let Some(g) = s(d, "guild_id").filter(|g| !g.is_empty()) {
                    self.threads.delete(g);
                }
            }
            "GUILD_ROLE_CREATE" | "GUILD_ROLE_UPDATE" => {
                if let (Some(g), Some(role)) = (s(d, "guild_id"), d.get("role")) {
                    self.upsert_role(g, role);
                }
            }
            "GUILD_ROLE_DELETE" => {
                if let (Some(g), Some(r)) = (s(d, "guild_id"), s(d, "role_id")) {
                    self.remove_role(g, r);
                }
            }
            "GUILD_EMOJIS_UPDATE" => {
                if let (Some(g), Some(emojis)) =
                    (s(d, "guild_id"), d.get("emojis").and_then(Value::as_array))
                {
                    self.emojis.set(g, Arc::new(emojis.clone()));
                }
            }
            _ => {}
        }
    }
}

/// Returns a new list with `item` replacing the entry of the same id, or appended.
fn upsert(list: &[Value], item: &Value) -> Vec<Value> {
    let key = id(item);
    let mut next = list.to_vec();
    match next.iter().position(|e| id(e) == key) {
        Some(i) => next[i] = item.clone(),
        None => next.push(item.clone()),
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(items: &[(&str, &str)]) -> Vec<Named> {
        items
            .iter()
            .map(|(i, n)| Named {
                id: (*i).into(),
                name: (*n).into(),
                detail: None,
            })
            .collect()
    }

    #[test]
    fn snowflakes() {
        assert!(is_snowflake("123456789012345678"));
        assert!(!is_snowflake("99999999999999999999"));
        assert!(!is_snowflake("1234"));
    }

    #[test]
    fn literal_beats_normalised() {
        let c = named(&[("1", "general"), ("2", "General")]);
        assert_eq!(pick_one(&c, "general", "channel", false).unwrap().id, "1");
        assert_eq!(pick_one(&c, "General", "channel", false).unwrap().id, "2");
    }

    #[test]
    fn substring_only_when_not_exact() {
        let c = named(&[("1", "bug-reports"), ("2", "random")]);
        assert_eq!(pick_one(&c, "bug", "channel", false).unwrap().id, "1");
        let e = pick_one(&c, "bug", "channel", true).unwrap_err();
        assert!(
            e.tool()
                .unwrap()
                .hint
                .as_ref()
                .unwrap()
                .starts_with("Destructive actions need the exact name")
        );
    }

    #[test]
    fn ambiguity_lists_matches() {
        let c = named(&[("1", "dev-a"), ("2", "dev-b")]);
        let e = pick_one(&c, "dev", "channel", false).unwrap_err();
        assert_eq!(
            e.tool().unwrap().message,
            "\"dev\" matches 2 channels, so it is ambiguous."
        );
    }

    #[test]
    fn normalises_spaces_and_case() {
        assert_eq!(normalize("Breakout Block"), "breakoutblock");
        assert_eq!(normalize("breakout-block"), "breakoutblock");
    }

    #[test]
    fn mentions() {
        let r = parse_ref("<@&123456789012345678>");
        assert_eq!(r.mention, Some(MentionKind::Role));
        let r = parse_ref("#general");
        assert_eq!(r.name, "general");
        assert!(r.id.is_none());
    }
}
