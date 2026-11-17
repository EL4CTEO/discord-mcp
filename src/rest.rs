//! Discord REST client.
//!
//! `Rest` is the facade the tools use: query strings, GET de-duplication and
//! per-caller cancellation. Underneath, `HttpTransport` talks to Discord with a
//! per-bucket queue that honours Discord's rate-limit headers and the global
//! limit, retries 5xx and network failures twice, and turns error bodies into
//! the same messages discord.js produced. Tests swap in a fake `Transport`.

use crate::errors::{Error, Result};
use crate::js::encode_uri_component;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const API_BASE: &str = "https://discord.com/api/v10";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
        }
    }
}

/// One attachment to send as multipart form data.
#[derive(Clone, Debug)]
pub struct RawFile {
    pub name: String,
    pub data: Vec<u8>,
    pub content_type: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: Method,
    /// Path below the API base, e.g. `/channels/123/messages`.
    pub route: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    pub reason: Option<String>,
    pub files: Vec<RawFile>,
}

pub trait Transport: Send + Sync {
    fn send(&self, request: Request) -> BoxFuture<'static, Result<Value>>;
}

/// A query parameter value; `None` values are dropped, as Discord rejects explicit nulls.
pub type Query<'a> = &'a [(&'a str, Option<String>)];

pub fn q<T: ToString>(value: T) -> Option<String> {
    Some(value.to_string())
}

pub fn qo<T: ToString>(value: Option<T>) -> Option<String> {
    value.map(|v| v.to_string())
}

type SharedGet = Shared<BoxFuture<'static, Result<Value>>>;

pub struct Rest {
    transport: Arc<dyn Transport>,
    in_flight: Mutex<HashMap<String, SharedGet>>,
}

impl Rest {
    pub fn new(transport: Arc<dyn Transport>) -> Arc<Self> {
        Arc::new(Self {
            transport,
            in_flight: Mutex::new(HashMap::new()),
        })
    }

    /// GET with in-flight de-duplication: identical GETs issued while one is in
    /// the air share its response. The shared request never takes a caller's
    /// cancellation; a cancelled caller only stops waiting.
    pub async fn get(
        self: &Arc<Self>,
        route: &str,
        query: Query<'_>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value> {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Timeout);
        }
        let query: Vec<(String, String)> = query
            .iter()
            .filter_map(|(k, v)| v.as_ref().map(|v| ((*k).to_string(), v.clone())))
            .collect();
        let key = format!("{route}?{}", encode_query(&query));

        let shared = {
            let mut map = self
                .in_flight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(pending) = map.get(&key) {
                pending.clone()
            } else {
                let this = Arc::clone(self);
                let request = Request {
                    method: Method::Get,
                    route: route.to_string(),
                    query,
                    body: None,
                    reason: None,
                    files: vec![],
                };
                let owned_key = key.clone();
                let task = tokio::spawn(async move {
                    let result = this.transport.send(request).await;
                    this.in_flight
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&owned_key);
                    result
                });
                let shared: SharedGet = async move {
                    task.await
                        .unwrap_or_else(|e| Err(Error::Other(e.to_string())))
                }
                .boxed()
                .shared();
                map.insert(key, shared.clone());
                shared
            }
        };

        match cancel {
            None => shared.await,
            Some(token) => tokio::select! {
                r = shared => r,
                () = token.cancelled() => Err(Error::Timeout),
            },
        }
    }

    async fn write(
        &self,
        method: Method,
        route: &str,
        body: Option<Value>,
        reason: Option<&str>,
        files: Vec<RawFile>,
    ) -> Result<Value> {
        self.transport
            .send(Request {
                method,
                route: route.to_string(),
                query: vec![],
                body,
                reason: reason.map(str::to_string),
                files,
            })
            .await
    }

    /// POST; when `files` are given the body is sent as multipart payload_json.
    pub async fn post(
        &self,
        route: &str,
        body: Option<Value>,
        reason: Option<&str>,
        files: Vec<RawFile>,
    ) -> Result<Value> {
        self.write(Method::Post, route, body, reason, files).await
    }

    pub async fn patch(&self, route: &str, body: Value, reason: Option<&str>) -> Result<Value> {
        self.write(Method::Patch, route, Some(body), reason, vec![])
            .await
    }

    pub async fn put(
        &self,
        route: &str,
        body: Option<Value>,
        reason: Option<&str>,
    ) -> Result<Value> {
        self.write(Method::Put, route, body, reason, vec![]).await
    }

    pub async fn delete(&self, route: &str, reason: Option<&str>) -> Result<Value> {
        self.write(Method::Delete, route, None, reason, vec![])
            .await
    }
}

/// `URLSearchParams.toString()`.
pub fn encode_query(query: &[(String, String)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in query {
        s.append_pair(k, v);
    }
    s.finish()
}

// --- HTTP transport --------------------------------------------------------

#[derive(Default)]
struct BucketState {
    remaining: Option<u64>,
    reset_at: Option<Instant>,
}

struct HttpInner {
    client: reqwest::Client,
    token: String,
    timeout: Duration,
    base: String,
    buckets: Mutex<HashMap<String, Arc<tokio::sync::Mutex<BucketState>>>>,
    global_until: Mutex<Option<Instant>>,
}

/// The real Discord transport; cheap to clone into each request's future.
pub struct HttpTransport {
    inner: Arc<HttpInner>,
}

/// Retries for 5xx answers and network failures, as discord.js did.
const RETRIES: u32 = 2;
/// 429 answers waited out before giving up on a request.
const RATE_LIMIT_RETRIES: u32 = 8;

impl HttpTransport {
    pub fn new(token: &str, timeout_ms: u64, user_agent: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(user_agent)
            .build()
            .map_err(|e| Error::Other(format!("could not build the HTTP client: {e}")))?;
        Ok(Self {
            inner: Arc::new(HttpInner {
                client,
                token: token.to_string(),
                timeout: Duration::from_millis(timeout_ms),
                base: API_BASE.to_string(),
                buckets: Mutex::new(HashMap::new()),
                global_until: Mutex::new(None),
            }),
        })
    }
}

impl HttpInner {
    fn bucket(&self, key: &str) -> Arc<tokio::sync::Mutex<BucketState>> {
        let mut map = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(map.entry(key.to_string()).or_default())
    }

    fn build(&self, req: &Request) -> Result<reqwest::RequestBuilder> {
        let method = match req.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Patch => reqwest::Method::PATCH,
            Method::Put => reqwest::Method::PUT,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut url = format!("{}{}", self.base, req.route);
        if !req.query.is_empty() {
            url.push('?');
            url.push_str(&encode_query(&req.query));
        }
        let mut builder = self
            .client
            .request(method, url)
            .timeout(self.timeout)
            .header("Authorization", format!("Bot {}", self.token));
        if let Some(reason) = &req.reason {
            builder = builder.header("X-Audit-Log-Reason", encode_uri_component(reason));
        }

        if req.files.is_empty() {
            if let Some(body) = &req.body {
                builder = builder
                    .header("Content-Type", "application/json")
                    .body(crate::js::stringify(body));
            }
        } else {
            let mut form = reqwest::multipart::Form::new();
            for (index, file) in req.files.iter().enumerate() {
                let mut part =
                    reqwest::multipart::Part::bytes(file.data.clone()).file_name(file.name.clone());
                if let Some(ct) = &file.content_type {
                    part = part.mime_str(ct).map_err(|e| Error::Other(e.to_string()))?;
                }
                form = form.part(format!("files[{index}]"), part);
            }
            if let Some(body) = &req.body {
                form = form.text("payload_json", crate::js::stringify(body));
            }
            builder = builder.multipart(form);
        }
        Ok(builder)
    }

    async fn wait_global(&self) {
        let until = *self
            .global_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(until) = until {
            let now = Instant::now();
            if until > now {
                tokio::time::sleep(until - now).await;
            }
        }
    }

    async fn execute(&self, req: Request) -> Result<Value> {
        let key = bucket_key(req.method, &req.route);
        let bucket = self.bucket(&key);
        // One request per bucket at a time, like discord.js's sequential handler.
        let mut state = bucket.lock().await;
        let mut failures = 0;
        let mut limited = 0;

        loop {
            self.wait_global().await;
            if state.remaining == Some(0)
                && let Some(reset) = state.reset_at
            {
                let now = Instant::now();
                if reset > now {
                    tokio::time::sleep(reset - now).await;
                }
            }

            let response = match self.build(&req)?.send().await {
                Ok(r) => r,
                Err(e) => {
                    if failures < RETRIES {
                        failures += 1;
                        continue;
                    }
                    return Err(if e.is_timeout() {
                        Error::Timeout
                    } else {
                        Error::Other(network_message(&e))
                    });
                }
            };

            let status = response.status();
            let headers = response.headers().clone();
            let header = |name: &str| {
                headers
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            if let Some(remaining) = header("x-ratelimit-remaining").and_then(|v| v.parse().ok()) {
                state.remaining = Some(remaining);
            }
            if let Some(after) =
                header("x-ratelimit-reset-after").and_then(|v| v.parse::<f64>().ok())
            {
                state.reset_at = Some(Instant::now() + Duration::from_secs_f64(after.max(0.0)));
            }

            let text = match response.text().await {
                Ok(t) => t,
                Err(e) => {
                    if failures < RETRIES {
                        failures += 1;
                        continue;
                    }
                    return Err(if e.is_timeout() {
                        Error::Timeout
                    } else {
                        Error::Other(network_message(&e))
                    });
                }
            };

            if status.as_u16() == 429 {
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let retry_after = body
                    .get("retry_after")
                    .and_then(Value::as_f64)
                    .or_else(|| header("retry-after").and_then(|v| v.parse().ok()))
                    .unwrap_or(1.0);
                let wait = Duration::from_secs_f64(retry_after.max(0.0));
                let global = body.get("global").and_then(Value::as_bool).unwrap_or(false)
                    || header("x-ratelimit-global").is_some();
                if limited >= RATE_LIMIT_RETRIES {
                    return Err(Error::RateLimit {
                        seconds: wait.as_secs_f64().ceil() as u64,
                        route: req.route.clone(),
                    });
                }
                limited += 1;
                if global {
                    *self
                        .global_until
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(Instant::now() + wait);
                }
                tokio::time::sleep(wait).await;
                continue;
            }

            if status.is_server_error() && failures < RETRIES {
                failures += 1;
                continue;
            }

            if status.is_success() {
                if text.is_empty() {
                    return Ok(Value::Null);
                }
                return serde_json::from_str(&text).or(Ok(Value::String(text)));
            }

            let parsed: Option<Value> = serde_json::from_str(&text).ok();
            return Err(match parsed.filter(Value::is_object) {
                Some(body) if body.get("code").is_some() || body.get("message").is_some() => {
                    let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
                    Error::Api {
                        status: status.as_u16(),
                        code,
                        message: discord_error_message(&body),
                    }
                }
                _ => Error::Http {
                    status: status.as_u16(),
                    message: status.canonical_reason().unwrap_or("Unknown").to_string(),
                },
            });
        }
    }
}

fn network_message(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(s) = source {
        message = format!("{message}: {s}");
        source = s.source();
    }
    message
}

impl Transport for HttpTransport {
    fn send(&self, request: Request) -> BoxFuture<'static, Result<Value>> {
        let inner = Arc::clone(&self.inner);
        async move { inner.execute(request).await }.boxed()
    }
}

/// Approximates Discord's rate-limit bucket: method + route with every id
/// replaced, except the major parameter (the channel, guild or webhook id).
pub fn bucket_key(method: Method, route: &str) -> String {
    let segments: Vec<&str> = route.split('/').collect();
    let mut out: Vec<String> = Vec::with_capacity(segments.len());
    let mut major_kept = false;
    let mut in_reactions = false;
    for (i, seg) in segments.iter().enumerate() {
        if in_reactions {
            out.push(":reaction".into());
            break;
        }
        let is_id = !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit());
        let previous = if i > 0 { segments[i - 1] } else { "" };
        if is_id {
            if !major_kept && matches!(previous, "channels" | "guilds" | "webhooks") {
                out.push((*seg).to_string());
                major_kept = true;
            } else {
                out.push(":id".into());
            }
        } else {
            out.push((*seg).to_string());
        }
        if *seg == "reactions" {
            in_reactions = true;
        }
    }
    format!("{} {}", method.as_str(), out.join("/"))
}

/// discord.js's message for an error body: the message, then every nested form error.
pub fn discord_error_message(body: &Value) -> String {
    let message = body.get("message").and_then(Value::as_str).unwrap_or("");
    let mut flattened = Vec::new();
    if let Some(errors) = body.get("errors") {
        flatten_errors(errors, "", &mut flattened);
    }
    let flat = flattened.join("\n");
    match (message.is_empty(), flat.is_empty()) {
        (false, false) => format!("{message}\n{flat}"),
        (false, true) => message.to_string(),
        (true, false) => flat,
        (true, true) => "Unknown Error".to_string(),
    }
}

fn flatten_errors(value: &Value, key: &str, out: &mut Vec<String>) {
    let Some(map) = value.as_object() else { return };
    if let Some(message) = map.get("message") {
        let code = map
            .get("code")
            .map(|c| c.as_str().map_or_else(|| c.to_string(), str::to_string))
            .unwrap_or_default();
        let message = message
            .as_str()
            .map_or_else(|| message.to_string(), str::to_string);
        let line = if key.is_empty() {
            format!("{code}: {message}")
        } else {
            format!("{key}[{code}]: {message}")
        };
        out.push(crate::js::trim(&line).to_string());
        return;
    }
    for (other, v) in map {
        let next = if other.starts_with('_') {
            key.to_string()
        } else if key.is_empty() {
            other.clone()
        } else if other.parse::<f64>().is_ok() {
            format!("{key}[{other}]")
        } else {
            format!("{key}.{other}")
        };
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Object(o) if o.get("_errors").is_some_and(Value::is_array) => {
                for e in o["_errors"].as_array().into_iter().flatten() {
                    flatten_errors(e, &next, out);
                }
            }
            Value::Object(_) => flatten_errors(v, &next, out),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn buckets_keep_major_parameter() {
        assert_eq!(
            bucket_key(
                Method::Get,
                "/channels/123456789012345678/messages/223456789012345678"
            ),
            "GET /channels/123456789012345678/messages/:id"
        );
        assert_eq!(
            bucket_key(
                Method::Put,
                "/channels/1/messages/2/reactions/%E2%9C%85/@me"
            ),
            "PUT /channels/1/messages/:id/reactions/:reaction"
        );
        assert_eq!(
            bucket_key(Method::Get, "/users/@me/guilds"),
            "GET /users/@me/guilds"
        );
    }

    #[test]
    fn form_errors_flatten_like_discord_js() {
        let body = json!({
            "code": 50035, "message": "Invalid Form Body",
            "errors": {"embeds": {"0": {"title": {"_errors": [{"code": "BASE_TYPE_MAX_LENGTH", "message": "Must be 256 or fewer in length."}]}}}}
        });
        assert_eq!(
            discord_error_message(&body),
            "Invalid Form Body\nembeds[0].title[BASE_TYPE_MAX_LENGTH]: Must be 256 or fewer in length."
        );
        assert_eq!(
            discord_error_message(&json!({"code": 10003, "message": "Unknown Channel"})),
            "Unknown Channel"
        );
    }

    #[test]
    fn query_encoding_matches_url_search_params() {
        let q = vec![
            ("query".to_string(), "a b&c".to_string()),
            ("limit".to_string(), "100".to_string()),
        ];
        assert_eq!(encode_query(&q), "query=a+b%26c&limit=100");
    }
}
