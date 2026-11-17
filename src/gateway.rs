//! Lazily-connected gateway listener.
//!
//! Most Discord work is plain REST, and opening a WebSocket costs seconds of
//! identify/ready handshake, so the socket opens only when an event-shaped tool
//! needs it and closes again after an idle period. Received dispatches land in
//! a bounded ring buffer so a tool can ask "what happened while you were
//! listening?" without holding the call open.

use crate::config::Config;
use crate::errors::{Error, Result, ToolError};
use crate::json::Obj;
use futures::FutureExt;
use futures::StreamExt;
use futures::future::{BoxFuture, Shared};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use twilight_gateway::{CloseFrame, Intents, Message, Shard, ShardId};

/// Gateway dispatches an agent can usefully wait for or review.
pub const EVENT_TYPES: &[&str] = &[
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_DELETE",
    "MESSAGE_DELETE_BULK",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "GUILD_MEMBER_ADD",
    "GUILD_MEMBER_REMOVE",
    "GUILD_MEMBER_UPDATE",
    "GUILD_BAN_ADD",
    "GUILD_BAN_REMOVE",
    "GUILD_ROLE_CREATE",
    "GUILD_ROLE_UPDATE",
    "GUILD_ROLE_DELETE",
    "CHANNEL_CREATE",
    "CHANNEL_UPDATE",
    "CHANNEL_DELETE",
    "THREAD_CREATE",
    "THREAD_UPDATE",
    "THREAD_DELETE",
    "VOICE_STATE_UPDATE",
    "INVITE_CREATE",
    "INVITE_DELETE",
];

/// Events whose `user` is the member affected, not whoever caused the change.
const SUBJECT_EVENTS: &[&str] = &[
    "GUILD_MEMBER_ADD",
    "GUILD_MEMBER_REMOVE",
    "GUILD_MEMBER_UPDATE",
    "GUILD_BAN_ADD",
    "GUILD_BAN_REMOVE",
];

/// Intents that any bot may use without portal configuration.
const BASE_INTENTS: u64 = (1 << 0)
    | (1 << 9)
    | (1 << 10)
    | (1 << 2)
    | (1 << 7)
    | (1 << 6)
    | (1 << 3)
    | (1 << 12)
    | (1 << 13);
/// MessageContent and GuildMembers: must be switched on in the Developer Portal first.
const PRIVILEGED_INTENTS: u64 = (1 << 15) | (1 << 1);

/// Pending wait calls allowed at once.
const MAX_WAITS: usize = 20;
/// Teardown never holds up a caller longer than this.
const TEARDOWN_CAP: Duration = Duration::from_millis(2_000);

/// Close codes after which reconnecting cannot succeed, with what to do about each.
fn fatal_close(code: u16) -> Option<(&'static str, &'static str)> {
    Some(match code {
        4004 => (
            "Discord rejected the bot token.",
            "Reset the token in the Developer Portal and update DISCORD_TOKEN.",
        ),
        4010 => (
            "Discord rejected the shard configuration as invalid.",
            "This is a bug in discord-mcp; please report it.",
        ),
        4011 => (
            "This bot is in too many servers for a single shard.",
            "discord-mcp runs one shard, so it cannot serve a bot this large yet.",
        ),
        4012 => (
            "Discord rejected the gateway API version.",
            "Update discord-mcp to the latest version.",
        ),
        4013 => (
            "Discord rejected the gateway intents as invalid.",
            "This is a bug in discord-mcp; please report it.",
        ),
        4014 => (
            "Discord refused the requested privileged gateway intents.",
            "Open the Developer Portal -> your app -> Bot and enable MESSAGE CONTENT INTENT and \
             SERVER MEMBERS INTENT, or set DISCORD_PRIVILEGED_INTENTS=false to listen without them.",
        ),
        _ => return None,
    })
}

/// One received gateway dispatch, trimmed to what an agent can act on.
#[derive(Clone, Debug)]
pub struct BufferedEvent {
    pub seq: u64,
    pub kind: String,
    pub guild_id: Option<String>,
    pub channel_id: Option<String>,
    /// Who caused the event.
    pub user: Option<String>,
    pub user_id: Option<String>,
    /// Full message text for message events; used for matching, never clipped.
    pub content: Option<String>,
    pub summary: String,
    /// The event as the tools report it, in the original's key order, with `data`.
    pub json: Obj,
}

impl BufferedEvent {
    /// The event without its raw payload unless asked for it.
    pub fn present(&self, include_raw: bool) -> Obj {
        let mut out = self.json.clone();
        if !include_raw {
            out.shift_remove("data");
        }
        out
    }
}

/// How a wait ended.
pub enum WaitResult {
    Matched(Box<BufferedEvent>),
    Timeout,
    Cancelled,
    Closed,
}

impl WaitResult {
    pub fn reason(&self) -> &'static str {
        match self {
            WaitResult::Matched(_) => "matched",
            WaitResult::Timeout => "timeout",
            WaitResult::Cancelled => "cancelled",
            WaitResult::Closed => "closed",
        }
    }
}

pub type Predicate = Arc<dyn Fn(&BufferedEvent) -> bool + Send + Sync>;
type Listener = Arc<dyn Fn(&str, &Value) + Send + Sync>;
type Connecting = Shared<BoxFuture<'static, Result<()>>>;

struct Waiter {
    predicate: Predicate,
    since: u64,
    tx: oneshot::Sender<WaitResult>,
}

struct Conn {
    id: u64,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct State {
    conn: Option<Conn>,
    connecting: Option<Connecting>,
    buffer: VecDeque<BufferedEvent>,
    seq: u64,
    started_at: Option<String>,
    last_error: Option<String>,
    privileged_refused: bool,
    waiters: HashMap<u64, Waiter>,
    next_id: u64,
    idle_deadline: Option<Instant>,
    idle_task: bool,
    /// Fails the handshake in progress, so disconnect() does not leave its caller waiting.
    abort_handshake: Option<oneshot::Sender<Error>>,
}

pub struct Gateway {
    config: Arc<Config>,
    state: Mutex<State>,
    listeners: Mutex<Vec<Listener>>,
}

impl Gateway {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            config,
            state: Mutex::new(State::default()),
            listeners: Mutex::new(Vec::new()),
        })
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_connected(&self) -> bool {
        let s = self.st();
        s.conn.is_some() && s.connecting.is_none()
    }

    pub fn listening_since(&self) -> Option<String> {
        self.st().started_at.clone()
    }

    /// Sequence number of the newest buffered event; 0 when nothing arrived yet.
    pub fn last_seq(&self) -> u64 {
        self.st().seq
    }

    /// Sequence number of the oldest event still buffered.
    pub fn oldest_seq(&self) -> Option<u64> {
        self.st().buffer.front().map(|e| e.seq)
    }

    /// False when message content and member events are unavailable.
    pub fn privileged_available(&self) -> bool {
        self.config.privileged_intents && !self.st().privileged_refused
    }

    pub fn last_error(&self) -> Option<String> {
        self.st().last_error.clone()
    }

    /// Receives every raw dispatch, buffered or not. Used to keep caches current.
    pub fn on_dispatch(&self, listener: impl Fn(&str, &Value) + Send + Sync + 'static) {
        self.listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Arc::new(listener));
    }

    /// Opens the socket if needed and refreshes the idle countdown.
    /// Concurrent callers share one connection attempt.
    pub async fn ensure_connected(self: &Arc<Self>) -> Result<()> {
        self.touch();
        let pending = {
            let mut s = self.st();
            if s.conn.is_some() && s.connecting.is_none() {
                return Ok(());
            }
            if let Some(p) = &s.connecting {
                p.clone()
            } else {
                let this = Arc::clone(self);
                let task = tokio::spawn(async move {
                    let result = this.connect().await;
                    this.st().connecting = None;
                    result
                });
                let shared: Connecting = async move {
                    task.await
                        .unwrap_or_else(|e| Err(Error::Other(e.to_string())))
                }
                .boxed()
                .shared();
                s.connecting = Some(shared.clone());
                shared
            }
        };
        pending.await
    }

    async fn connect(self: &Arc<Self>) -> Result<()> {
        let privileged = self.privileged_available();
        let intents = if privileged {
            BASE_INTENTS | PRIVILEGED_INTENTS
        } else {
            BASE_INTENTS
        };
        match self.open(intents).await {
            Err(Error::Tool(t)) if privileged && t.code == Some(crate::errors::Code::Num(4014)) => {
                // Discord refuses the whole identify when a privileged intent is off in the portal.
                self.st().privileged_refused = true;
                eprintln!(
                    "discord-mcp: privileged intents refused; continuing without message content and member events."
                );
                self.open(BASE_INTENTS).await
            }
            other => other,
        }
    }

    /// Opens one shard with the given intents and waits for READY.
    async fn open(self: &Arc<Self>, intents: u64) -> Result<()> {
        let (ready_tx, ready_rx) = oneshot::channel::<Result<()>>();
        let (abort_tx, abort_rx) = oneshot::channel::<Error>();
        let cancel = CancellationToken::new();
        let conn_id = {
            let mut s = self.st();
            s.next_id += 1;
            s.abort_handshake = Some(abort_tx);
            s.next_id
        };

        let shard = Shard::new(
            ShardId::ONE,
            self.config.token.clone(),
            Intents::from_bits_truncate(intents),
        );
        let this = Arc::clone(self);
        let task = tokio::spawn(this.run_shard(shard, conn_id, cancel.clone(), ready_tx));
        self.st().conn = Some(Conn {
            id: conn_id,
            cancel: cancel.clone(),
            task,
        });

        let timeout = Duration::from_millis(self.config.request_timeout_ms * 2);
        let outcome: Result<()> = tokio::select! {
            r = ready_rx => r.unwrap_or_else(|_| Err(closed_while_connecting())),
            e = abort_rx => Err(e.unwrap_or_else(|_| closed_while_connecting())),
            () = tokio::time::sleep(timeout) => Err(ToolError::new("Timed out connecting to the Discord gateway.")
                .code("GATEWAY_TIMEOUT")
                .hint("Check network access to gateway.discord.gg and that DISCORD_TOKEN is valid.")
                .into()),
        };

        let still_current = {
            let mut s = self.st();
            s.abort_handshake = None;
            s.conn.as_ref().is_some_and(|c| c.id == conn_id)
        };
        match outcome {
            Ok(()) if still_current => {
                self.st().started_at = Some(crate::js::iso_from_ms(crate::js::now_ms()));
                Ok(())
            }
            other => {
                let error = other.err().unwrap_or_else(closed_while_connecting);
                let dropped = {
                    let mut s = self.st();
                    if s.conn.as_ref().is_some_and(|c| c.id == conn_id) {
                        s.conn.take()
                    } else {
                        None
                    }
                };
                cancel.cancel();
                if let Some(conn) = dropped {
                    discard(conn).await;
                }
                Err(error)
            }
        }
    }

    async fn run_shard(
        self: Arc<Self>,
        mut shard: Shard,
        conn_id: u64,
        cancel: CancellationToken,
        ready: oneshot::Sender<Result<()>>,
    ) {
        let mut ready = Some(ready);
        loop {
            let next = tokio::select! {
                () = cancel.cancelled() => {
                    shard.close(CloseFrame::NORMAL);
                    // Give the close frame a moment to go out, then drop the socket.
                    let _ = tokio::time::timeout(Duration::from_millis(500), async { while shard.next().await.is_some() {} }).await;
                    return;
                }
                n = shard.next() => n,
            };
            let current = || self.st().conn.as_ref().is_some_and(|c| c.id == conn_id);
            match next {
                None => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Err(closed_while_connecting()));
                    }
                    return;
                }
                Some(Ok(Message::Text(text))) => {
                    let Ok(payload) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if payload.get("op").and_then(Value::as_i64) != Some(0) {
                        continue;
                    }
                    let kind = payload
                        .get("t")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let data = payload.get("d").cloned().unwrap_or(Value::Null);
                    if kind == "READY"
                        && let Some(tx) = ready.take()
                    {
                        let _ = tx.send(Ok(()));
                    }
                    // Only the current connection may feed the buffer.
                    if current() {
                        self.ingest(&kind, data);
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.as_ref().map_or(0, |f| f.code);
                    if let Some((message, hint)) = fatal_close(code) {
                        self.st().last_error = Some(message.to_string());
                        if let Some(tx) = ready.take() {
                            let _ = tx.send(Err(ToolError::new(message)
                                .num(i64::from(code))
                                .hint(hint)
                                .into()));
                            return;
                        }
                        // After a fatal close nothing reconnects: forget the connection so
                        // the next call reconnects and reports the real problem.
                        if current() && self.st().connecting.is_none() {
                            let this = Arc::clone(&self);
                            tokio::spawn(async move { this.disconnect().await });
                        }
                        return;
                    }
                }
                Some(Err(error)) => {
                    let message = error.to_string();
                    eprintln!("discord-mcp: gateway error: {message}");
                    self.st().last_error = Some(message);
                    if matches!(
                        error.kind(),
                        twilight_gateway::error::ReceiveMessageErrorType::Reconnect
                    ) {
                        if let Some(tx) = ready.take() {
                            let _ = tx.send(Err(Error::Other(error.to_string())));
                            return;
                        }
                        if current() && self.st().connecting.is_none() {
                            let this = Arc::clone(&self);
                            tokio::spawn(async move { this.disconnect().await });
                        }
                        return;
                    }
                }
            }
        }
    }

    /// Feeds one dispatch through cache listeners and the event buffer. Public for tests.
    pub fn ingest(&self, kind: &str, data: Value) {
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for listener in listeners {
            // A cache-maintenance bug must never take the event stream down.
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(kind, &data)));
        }
        if EVENT_TYPES.contains(&kind) {
            self.record(kind, data);
        }
    }

    fn record(&self, kind: &str, payload: Value) {
        let empty = Value::Object(Obj::new());
        let d = if payload.is_object() {
            &payload
        } else {
            &empty
        };
        let mut s = self.st();
        s.seq += 1;
        let seq = s.seq;
        let summary = summarize(kind, d);

        let mut json = Obj::new();
        json.insert("seq".into(), seq.into());
        json.insert("type".into(), kind.into());
        json.insert(
            "at".into(),
            crate::js::iso_from_ms(crate::js::now_ms()).into(),
        );
        json.insert("summary".into(), summary.clone().into());
        if !payload.is_null() {
            json.insert("data".into(), payload.clone());
        }

        let str_of = |key: &str| d.get(key).and_then(Value::as_str).map(str::to_string);
        let guild_id = str_of("guild_id");
        let mut channel_id = str_of("channel_id");
        if channel_id.is_none()
            && d.get("channel_id").is_none_or(|v| !v.is_string())
            && (kind.starts_with("THREAD_") || kind.starts_with("CHANNEL_"))
        {
            channel_id = str_of("id");
        }
        let message_id = if kind.starts_with("MESSAGE_") {
            match d.get("message_id").filter(|v| !v.is_null()) {
                Some(v) => v.as_str().map(str::to_string),
                None => str_of("id"),
            }
        } else {
            None
        };
        if let Some(g) = &guild_id {
            json.insert("guild_id".into(), g.clone().into());
        }
        if let Some(c) = &channel_id {
            json.insert("channel_id".into(), c.clone().into());
        }
        if let Some(m) = &message_id {
            json.insert("message_id".into(), m.clone().into());
        }

        let who = actor(d);
        let (mut user, mut user_id) = (None, None);
        if SUBJECT_EVENTS.contains(&kind) {
            if let Some((id, name)) = &who {
                json.insert("target_user".into(), name.clone().into());
                json.insert("target_user_id".into(), id.clone().into());
            }
        } else if let Some((id, name)) = who {
            json.insert("user".into(), name.clone().into());
            json.insert("user_id".into(), id.clone().into());
            user = Some(name);
            user_id = Some(id);
        } else if let Some(uid) = str_of("user_id") {
            json.insert("user_id".into(), uid.clone().into());
            user_id = Some(uid);
        }
        let content = str_of("content");
        if let Some(c) = &content {
            json.insert("content".into(), c.clone().into());
        }

        let event = BufferedEvent {
            seq,
            kind: kind.to_string(),
            guild_id,
            channel_id,
            user,
            user_id,
            content,
            summary,
            json,
        };
        s.buffer.push_back(event.clone());
        if s.buffer.len() > self.config.event_buffer_size {
            s.buffer.pop_front();
        }

        let matched: Vec<u64> = s
            .waiters
            .iter()
            .filter(|(_, w)| event.seq > w.since && (w.predicate)(&event))
            .map(|(id, _)| *id)
            .collect();
        for id in matched {
            if let Some(w) = s.waiters.remove(&id) {
                let _ = w.tx.send(WaitResult::Matched(Box::new(event.clone())));
            }
        }
    }

    /// Buffered events, oldest first, optionally filtered. With a cursor the
    /// oldest matches come first; without one the newest matches are returned.
    pub fn recent(
        &self,
        matcher: &Predicate,
        after_seq: Option<u64>,
        limit: usize,
    ) -> Vec<BufferedEvent> {
        let s = self.st();
        let after = after_seq.unwrap_or(0);
        let matched: Vec<BufferedEvent> = s
            .buffer
            .iter()
            .filter(|e| e.seq > after && matcher(e))
            .cloned()
            .collect();
        if after_seq.is_none() {
            let skip = matched.len().saturating_sub(limit);
            matched.into_iter().skip(skip).collect()
        } else {
            matched.into_iter().take(limit).collect()
        }
    }

    /// Resolves with the first event matching `predicate`, or with why it stopped.
    /// Events already buffered after `after_seq` are checked first. The timeout
    /// starts now, not once the socket is open.
    pub async fn wait_for(
        self: &Arc<Self>,
        predicate: Predicate,
        timeout_ms: u64,
        after_seq: Option<u64>,
        cancel: Option<&CancellationToken>,
    ) -> Result<WaitResult> {
        let (since, rx, waiter_id) = {
            let mut s = self.st();
            let since = after_seq.unwrap_or(s.seq);
            if let Some(early) = s.buffer.iter().find(|e| e.seq > since && predicate(e)) {
                return Ok(WaitResult::Matched(Box::new(early.clone())));
            }
            if cancel.is_some_and(CancellationToken::is_cancelled) {
                return Ok(WaitResult::Cancelled);
            }
            if s.waiters.len() >= MAX_WAITS {
                return Err(ToolError::new(format!(
                    "Too many event waits are already pending (limit {MAX_WAITS})."
                ))
                .code("TOO_MANY_WAITS")
                .hint("Let a pending wait finish or cancel it, then retry.")
                .into());
            }
            let (tx, rx) = oneshot::channel();
            s.next_id += 1;
            let id = s.next_id;
            s.waiters.insert(
                id,
                Waiter {
                    predicate,
                    since,
                    tx,
                },
            );
            (since, rx, id)
        };
        let _ = since;

        // Events can arrive while the socket opens and are offered to the waiter above.
        let connect = {
            let this = Arc::clone(self);
            async move { this.ensure_connected().await }
        };
        let never = CancellationToken::new();
        let cancel = cancel.unwrap_or(&never);
        let sleep = tokio::time::sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(sleep, rx, connect);
        let mut connected = false;

        let outcome: Result<WaitResult> = loop {
            tokio::select! {
                r = &mut rx => break Ok(r.unwrap_or(WaitResult::Closed)),
                () = &mut sleep => break Ok(WaitResult::Timeout),
                () = cancel.cancelled() => break Ok(WaitResult::Cancelled),
                r = &mut connect, if !connected => {
                    connected = true;
                    if let Err(e) = r { break Err(e); }
                }
            }
        };

        self.st().waiters.remove(&waiter_id);
        if !matches!(outcome, Ok(WaitResult::Closed)) {
            self.touch();
        }
        outcome
    }

    /// Restarts the idle countdown that eventually drops the socket. It never
    /// fires while a wait is pending or a connect is in flight.
    fn touch(self: &Arc<Self>) {
        let mut s = self.st();
        s.idle_deadline = Some(Instant::now() + Duration::from_millis(self.config.gateway_idle_ms));
        if s.idle_task {
            return;
        }
        s.idle_task = true;
        drop(s);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let deadline = this.st().idle_deadline;
                let Some(deadline) = deadline else {
                    this.st().idle_task = false;
                    return;
                };
                if Instant::now() < deadline {
                    tokio::time::sleep_until(deadline.into()).await;
                    continue;
                }
                let busy = {
                    let s = this.st();
                    !s.waiters.is_empty() || s.connecting.is_some()
                };
                if busy {
                    this.st().idle_deadline =
                        Some(Instant::now() + Duration::from_millis(this.config.gateway_idle_ms));
                    continue;
                }
                {
                    let mut s = this.st();
                    s.idle_task = false;
                    s.idle_deadline = None;
                }
                this.disconnect().await;
                return;
            }
        });
    }

    /// Drops the socket and ends every pending wait with reason "closed".
    pub async fn disconnect(&self) {
        let conn = {
            let mut s = self.st();
            s.idle_deadline = None;
            if let Some(abort) = s.abort_handshake.take() {
                let _ = abort.send(closed_while_connecting());
            }
            for (_, w) in s.waiters.drain() {
                let _ = w.tx.send(WaitResult::Closed);
            }
            s.started_at = None;
            s.conn.take()
        };
        if let Some(conn) = conn {
            discard(conn).await;
        }
    }
}

/// Tears a connection down, bounded in time so a stalled close cannot hang shutdown.
async fn discard(conn: Conn) {
    conn.cancel.cancel();
    let mut task = conn.task;
    if tokio::time::timeout(TEARDOWN_CAP, &mut task).await.is_err() {
        task.abort();
        eprintln!("discord-mcp: gateway teardown did not confirm every shard closed");
    }
}

fn closed_while_connecting() -> Error {
    ToolError::new("Gateway closed while connecting.")
        .code("GATEWAY_CLOSED")
        .hint("Retry the call.")
        .into()
}

/// Who caused an event, from whichever field that dispatch uses.
fn actor(d: &Value) -> Option<(String, String)> {
    let nn = |v: Option<&Value>| v.filter(|x| !x.is_null()).cloned();
    let candidate = nn(d.get("author"))
        .or_else(|| nn(d.get("user")))
        .or_else(|| nn(d.get("member").and_then(|m| m.get("user"))))
        .or_else(|| nn(d.get("inviter")))?;
    if !candidate.is_object() {
        return None;
    }
    let id = candidate.get("id")?.as_str()?.to_string();
    let name = candidate.get("username")?.as_str()?.to_string();
    Some((id, name))
}

/// `String(value)` in JS.
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// One-line, human-readable description of a dispatch, with every run of
/// whitespace collapsed (names and text are written by strangers).
fn summarize(kind: &str, d: &Value) -> String {
    let text = describe(kind, d);
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if crate::js::is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    crate::js::trim(&out).to_string()
}

fn describe(kind: &str, d: &Value) -> String {
    let username = |key: &str, fallback: &str| -> String {
        d.get(key)
            .and_then(|u| u.get("username"))
            .filter(|v| !v.is_null())
            .map_or_else(|| fallback.to_string(), |v| js_string(Some(v)))
    };
    let member_name = || {
        d.get("member")
            .and_then(|m| m.get("user"))
            .and_then(|u| u.get("username"))
            .filter(|v| !v.is_null())
            .map(|v| js_string(Some(v)))
    };

    match kind {
        "MESSAGE_CREATE" | "MESSAGE_UPDATE" => {
            let content = d.get("content").and_then(Value::as_str).unwrap_or("");
            let text = if crate::js::len16(content) > 160 {
                format!("{}\u{2026}", crate::js::prefix16(content, 159))
            } else {
                content.to_string()
            };
            format!(
                "{}: {}",
                username("author", "someone"),
                if text.is_empty() {
                    "(no text content)".to_string()
                } else {
                    text
                }
            )
        }
        "MESSAGE_DELETE" => format!("message {} deleted", js_string(d.get("id"))),
        "MESSAGE_DELETE_BULK" => {
            let n = d
                .get("ids")
                .and_then(Value::as_array)
                .map_or_else(|| "several".to_string(), |a| a.len().to_string());
            format!("{n} messages bulk-deleted")
        }
        "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE" => {
            let emoji = d
                .get("emoji")
                .and_then(|e| e.get("name"))
                .filter(|v| !v.is_null())
                .map_or_else(|| "a reaction".to_string(), |v| js_string(Some(v)));
            let who =
                member_name().unwrap_or_else(|| format!("user {}", js_string(d.get("user_id"))));
            let verb = if kind == "MESSAGE_REACTION_ADD" {
                "added"
            } else {
                "removed"
            };
            format!(
                "{who} {verb} {emoji} on message {}",
                js_string(d.get("message_id"))
            )
        }
        "GUILD_MEMBER_ADD" => format!("{} joined", username("user", "a member")),
        "GUILD_MEMBER_REMOVE" => format!("{} left", username("user", "a member")),
        "GUILD_MEMBER_UPDATE" => format!("{} was updated", username("user", "a member")),
        "GUILD_BAN_ADD" => format!("{} banned", username("user", "a user")),
        "GUILD_BAN_REMOVE" => format!("{} unbanned", username("user", "a user")),
        "GUILD_ROLE_CREATE" | "GUILD_ROLE_UPDATE" => {
            let name = d
                .get("role")
                .and_then(|r| r.get("name"))
                .filter(|v| !v.is_null())
                .map_or_else(|| "?".to_string(), |v| js_string(Some(v)));
            format!(
                "role {name} {}",
                if kind == "GUILD_ROLE_CREATE" {
                    "created"
                } else {
                    "updated"
                }
            )
        }
        "GUILD_ROLE_DELETE" => format!("role {} deleted", js_string(d.get("role_id"))),
        "CHANNEL_CREATE" | "CHANNEL_UPDATE" | "CHANNEL_DELETE" | "THREAD_CREATE"
        | "THREAD_UPDATE" | "THREAD_DELETE" => {
            let verb = if kind.ends_with("CREATE") {
                "created"
            } else if kind.ends_with("DELETE") {
                "deleted"
            } else {
                "updated"
            };
            let what = if kind.starts_with("THREAD") {
                "thread"
            } else {
                "channel"
            };
            let name = d
                .get("name")
                .filter(|v| !v.is_null())
                .or_else(|| d.get("id"));
            format!("{what} {} {verb}", js_string(name))
        }
        "VOICE_STATE_UPDATE" => {
            let who = member_name().unwrap_or_else(|| js_string(d.get("user_id")));
            if crate::json::truthy(d.get("channel_id")) {
                format!(
                    "{who} is in voice channel {}",
                    js_string(d.get("channel_id"))
                )
            } else {
                format!("{who} left voice")
            }
        }
        "INVITE_CREATE" => format!(
            "invite {} created by {}",
            js_string(d.get("code")),
            username("inviter", "someone")
        ),
        "INVITE_DELETE" => format!("invite {} deleted", js_string(d.get("code"))),
        _ => kind.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gateway() -> Arc<Gateway> {
        let env: HashMap<String, String> = [("DISCORD_TOKEN".to_string(), "t".to_string())].into();
        Gateway::new(Arc::new(crate::config::load_config(&env).unwrap()))
    }

    #[test]
    fn records_message_events() {
        let g = gateway();
        g.ingest(
            "MESSAGE_CREATE",
            json!({"id": "1", "channel_id": "2", "guild_id": "3", "content": "hello\nthere", "author": {"id": "4", "username": "bob"}}),
        );
        g.ingest("READY", json!({}));
        let all: Predicate = Arc::new(|_| true);
        let events = g.recent(&all, None, 10);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.summary, "bob: hello there");
        assert_eq!(e.user.as_deref(), Some("bob"));
        let present = e.present(false);
        let keys: Vec<&String> = present.keys().collect();
        assert_eq!(
            keys,
            [
                "seq",
                "type",
                "at",
                "summary",
                "guild_id",
                "channel_id",
                "message_id",
                "user",
                "user_id",
                "content"
            ]
        );
    }

    #[test]
    fn subject_events_record_target() {
        let g = gateway();
        g.ingest(
            "GUILD_MEMBER_ADD",
            json!({"guild_id": "3", "user": {"id": "4", "username": "new"}}),
        );
        let all: Predicate = Arc::new(|_| true);
        let e = &g.recent(&all, None, 10)[0];
        assert_eq!(e.summary, "new joined");
        assert!(e.user.is_none());
        assert_eq!(e.json["target_user"], "new");
    }

    #[test]
    fn ring_buffer_and_cursor() {
        let g = gateway();
        for n in 0..250 {
            g.ingest(
                "MESSAGE_DELETE",
                json!({"id": n.to_string(), "channel_id": "1"}),
            );
        }
        let all: Predicate = Arc::new(|_| true);
        assert_eq!(g.oldest_seq(), Some(51));
        let page = g.recent(&all, Some(100), 5);
        assert_eq!(
            page.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![101, 102, 103, 104, 105]
        );
        let newest = g.recent(&all, None, 2);
        assert_eq!(
            newest.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![249, 250]
        );
    }

    #[test]
    fn listeners_see_every_dispatch() {
        let g = gateway();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = Arc::clone(&seen);
        g.on_dispatch(move |t, _| s2.lock().unwrap().push(t.to_string()));
        g.ingest("GUILD_CREATE", json!({}));
        assert_eq!(*seen.lock().unwrap(), vec!["GUILD_CREATE"]);
    }

    #[tokio::test]
    async fn wait_finds_buffered_event() {
        let g = gateway();
        g.ingest("MESSAGE_DELETE", json!({"id": "9", "channel_id": "1"}));
        let all: Predicate = Arc::new(|_| true);
        let r = g.wait_for(all, 10, Some(0), None).await.unwrap();
        assert_eq!(r.reason(), "matched");
    }

    #[test]
    fn summaries() {
        assert_eq!(
            summarize(
                "MESSAGE_REACTION_ADD",
                &json!({"user_id": "5", "message_id": "6", "emoji": {"name": "✅"}})
            ),
            "user 5 added ✅ on message 6"
        );
        assert_eq!(
            summarize("MESSAGE_DELETE_BULK", &json!({"ids": ["1", "2"]})),
            "2 messages bulk-deleted"
        );
        assert_eq!(
            summarize(
                "VOICE_STATE_UPDATE",
                &json!({"user_id": "5", "channel_id": null})
            ),
            "5 left voice"
        );
        assert_eq!(
            summarize("CHANNEL_CREATE", &json!({"id": "5", "name": "general"})),
            "channel general created"
        );
    }
}
