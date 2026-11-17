//! The tool registry: one execution path for every tool.
//!
//! The destructive gate, argument validation, error normalisation, bulk
//! fan-out and the batch dispatcher all live here, so a tool invoked through
//! discord_batch behaves exactly like a direct call. Each tool's advertised
//! title, description, annotations and JSON schema come from `catalog.json`;
//! arguments are validated against that same schema.

pub mod batch;
pub mod channels;
pub mod community;
pub mod events;
pub mod guild;
pub mod members;
pub mod messages;
pub mod moderation;
pub mod roles;
pub mod util;

use crate::config::Config;
use crate::errors::{
    Code, Error, Result, ToolError, destructive_disabled, error_text, normalize_error,
};
use crate::format::Detail;
use crate::gateway::Gateway;
use crate::json::Obj;
use crate::limiter::map_lanes;
use crate::render::{clip_summary, describe_trim, fit_to_budget};
use crate::resolve::Resolver;
use crate::rest::Rest;
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio_util::sync::CancellationToken;

/// Reports progress of a long-running call: (done, total, message).
pub type Progress = Arc<dyn Fn(u64, u64, Option<String>) + Send + Sync>;

/// What a handler returns: a one-line human summary plus optional structured data.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub summary: String,
    pub data: Option<Value>,
    /// Set by a fan-out in which some or all items failed.
    pub failed: Option<Failed>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failed {
    All,
    Some,
}

impl Outcome {
    pub fn text(summary: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            data: None,
            failed: None,
        }
    }

    pub fn with(summary: impl Into<String>, data: Value) -> Self {
        Self {
            summary: summary.into(),
            data: Some(data),
            failed: None,
        }
    }
}

/// Per-item result of a fan-out, in the caller's order.
#[derive(Clone, Debug)]
pub struct BulkItem {
    pub value: Value,
    pub ok: bool,
    pub summary: Option<String>,
    pub data: Option<Value>,
    pub error: Option<String>,
}

impl BulkItem {
    pub fn ok(value: impl Into<Value>, summary: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            ok: true,
            summary: Some(summary.into()),
            data: None,
            error: None,
        }
    }

    pub fn err(value: impl Into<Value>, error: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            ok: false,
            summary: None,
            data: None,
            error: Some(error.into()),
        }
    }
}

/// Validated tool arguments, with JS-style accessors (absent and null are distinct).
#[derive(Clone, Debug, Default)]
pub struct Args(pub Obj);

impl Args {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// The argument as a string, when it is one.
    pub fn str(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(Value::as_str).map(str::to_string)
    }

    pub fn bool(&self, key: &str) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn opt_bool(&self, key: &str) -> Option<bool> {
        self.0.get(key).and_then(Value::as_bool)
    }

    pub fn i64(&self, key: &str) -> Option<i64> {
        self.0.get(key).and_then(Value::as_i64)
    }

    pub fn strs(&self, key: &str) -> Option<Vec<String>> {
        self.0
            .get(key)
            .and_then(Value::as_array)
            .map(|a| crate::json::strings(a))
    }

    pub fn arr(&self, key: &str) -> Option<&Vec<Value>> {
        self.0.get(key).and_then(Value::as_array)
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn detail(&self) -> Detail {
        Detail::parse(self.0.get("detail").and_then(Value::as_str))
    }

    /// Reason for the audit log.
    pub fn reason(&self) -> Option<String> {
        self.str("reason")
    }

    /// A copy with one key replaced.
    pub fn with(&self, key: &str, value: Value) -> Args {
        let mut next = self.0.clone();
        next.insert(key.to_string(), value);
        Args(next)
    }
}

pub type Handler = fn(Args, Ctx) -> BoxFuture<'static, Result<Outcome>>;
pub type BulkHandler =
    fn(Args, String, Vec<String>, Ctx) -> BoxFuture<'static, Result<Option<Vec<BulkItem>>>>;
/// Checks a JSON schema cannot express (zod refinements); returns (path, message) issues.
pub type ExtraCheck = fn(&Obj) -> Vec<(String, String)>;

pub struct ToolDef {
    pub name: &'static str,
    /// Gated behind DISCORD_ALLOW_DESTRUCTIVE, and hidden from clients while it is off.
    pub destructive: bool,
    /// Arguments that may also be given as an array, turning one call into a bulk one.
    pub bulk_args: &'static [&'static str],
    /// Replaces the generic hint when Discord answers 50013 (Missing Permissions).
    pub missing_permission_hint: Option<&'static str>,
    pub handler: Handler,
    /// Fast path for an array call, for tools where Discord offers a real bulk endpoint.
    pub bulk_handler: Option<BulkHandler>,
    pub extra_check: Option<ExtraCheck>,
}

impl ToolDef {
    pub const fn new(name: &'static str, handler: Handler) -> Self {
        Self {
            name,
            destructive: false,
            bulk_args: &[],
            missing_permission_hint: None,
            handler,
            bulk_handler: None,
            extra_check: None,
        }
    }
}

/// A tool's advertised metadata, from the catalog.
#[derive(Clone, Debug)]
pub struct Meta {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Obj,
    pub annotations: Obj,
}

static CATALOG: LazyLock<Vec<Meta>> = LazyLock::new(|| {
    let raw: Value =
        serde_json::from_str(include_str!("catalog.json")).unwrap_or(Value::Array(vec![]));
    raw.as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|t| Meta {
                    name: t["name"].as_str().unwrap_or("").to_string(),
                    title: t["title"].as_str().unwrap_or("").to_string(),
                    description: t["description"].as_str().unwrap_or("").to_string(),
                    input_schema: t["inputSchema"].as_object().cloned().unwrap_or_default(),
                    annotations: t["annotations"].as_object().cloned().unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
});

pub fn catalog() -> &'static [Meta] {
    &CATALOG
}

/// Every tool, in the order they are advertised: orientation tools first.
pub fn all_tools() -> Vec<ToolDef> {
    vec![
        guild::who_am_i(),
        guild::list_guilds(),
        guild::get_guild(),
        channels::list_channels(),
        channels::create_channel(),
        channels::edit_channel(),
        channels::delete_channel(),
        channels::manage_thread(),
        channels::set_channel_permissions(),
        channels::reorder_channels(),
        messages::send_message(),
        messages::send_dm(),
        messages::read_messages(),
        messages::search_messages(),
        messages::edit_message(),
        messages::delete_message(),
        messages::react(),
        messages::pin_message(),
        messages::manage_poll(),
        members::list_members(),
        members::get_member(),
        members::edit_member(),
        members::manage_member_roles(),
        roles::list_roles(),
        roles::manage_role(),
        roles::reorder_roles(),
        moderation::moderate_member(),
        moderation::bulk_delete(),
        moderation::list_bans(),
        moderation::get_audit_log(),
        community::manage_automod(),
        guild::create_invite(),
        community::manage_invites(),
        community::manage_scheduled_events(),
        community::manage_emojis(),
        events::wait_for_event(),
        events::recent_events(),
        batch::batch(),
    ]
}

/// Long-lived services shared by every call.
pub struct Services {
    pub config: Arc<Config>,
    pub rest: Arc<Rest>,
    pub resolver: Arc<Resolver>,
    pub gateway: Arc<Gateway>,
}

/// Everything a tool handler is allowed to touch. Cheap to clone.
#[derive(Clone)]
pub struct Ctx {
    pub config: Arc<Config>,
    pub rest: Arc<Rest>,
    pub resolver: Arc<Resolver>,
    pub gateway: Arc<Gateway>,
    /// Fires when the client cancels the call.
    pub cancel: CancellationToken,
    pub progress: Progress,
    /// True when running as a discord_batch operation, which already supplies the parallelism.
    pub in_batch: bool,
    registry: Arc<Registry>,
}

impl Ctx {
    /// Runs another registered tool by name, as a batch operation.
    pub fn invoke(&self, name: String, args: Value) -> BoxFuture<'static, Result<Outcome>> {
        let registry = Arc::clone(&self.registry);
        let cancel = self.cancel.clone();
        async move {
            registry
                .run(
                    &name,
                    args,
                    RunOptions {
                        cancel: Some(cancel),
                        progress: None,
                        in_batch: true,
                    },
                )
                .await
        }
        .boxed()
    }

    /// Whether a registered tool takes the named argument.
    pub fn accepts(&self, tool: &str, key: &str) -> bool {
        self.registry.meta(tool).is_some_and(|m| {
            m.input_schema
                .get("properties")
                .and_then(|p| p.get(key))
                .is_some()
        })
    }

    /// The arguments a registered tool fans out over.
    pub fn bulk_args(&self, tool: &str) -> &'static [&'static str] {
        self.registry.tools.get(tool).map_or(&[], |t| t.bulk_args)
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

#[derive(Default)]
pub struct RunOptions {
    pub cancel: Option<CancellationToken>,
    pub progress: Option<Progress>,
    pub in_batch: bool,
}

pub struct Registry {
    tools: HashMap<&'static str, ToolDef>,
    order: Vec<&'static str>,
    metas: HashMap<String, Meta>,
    validators: Mutex<HashMap<String, Arc<jsonschema::Validator>>>,
    services: Services,
    me: std::sync::Weak<Registry>,
}

impl Registry {
    pub fn new(services: Services, tools: Vec<ToolDef>) -> Arc<Self> {
        let metas: HashMap<String, Meta> = catalog()
            .iter()
            .map(|m| (m.name.clone(), m.clone()))
            .collect();
        let order = tools.iter().map(|t| t.name).collect();
        let tools = tools.into_iter().map(|t| (t.name, t)).collect();
        Arc::new_cyclic(|me| Self {
            tools,
            order,
            metas,
            validators: Mutex::new(HashMap::new()),
            services,
            me: me.clone(),
        })
    }

    pub fn meta(&self, name: &str) -> Option<&Meta> {
        self.metas.get(name)
    }

    pub fn is_destructive(&self, name: &str) -> bool {
        self.tools.get(name).is_some_and(|t| t.destructive)
    }

    /// The tools a client may see: destructive-only tools stay hidden while destructive actions are off.
    pub fn advertised(&self) -> Vec<&Meta> {
        self.order
            .iter()
            .filter(|n| self.services.config.allow_destructive || !self.is_destructive(n))
            .filter_map(|n| self.metas.get(*n))
            .collect()
    }

    fn arc(&self) -> Arc<Registry> {
        // INFALLIBLE: a Registry only ever exists inside the Arc built by `new`.
        self.me.upgrade().expect("registry is alive while it runs")
    }

    fn context(&self, options: &RunOptions) -> Ctx {
        Ctx {
            config: Arc::clone(&self.services.config),
            rest: Arc::clone(&self.services.rest),
            resolver: Arc::clone(&self.services.resolver),
            gateway: Arc::clone(&self.services.gateway),
            cancel: options.cancel.clone().unwrap_or_default(),
            progress: options
                .progress
                .clone()
                .unwrap_or_else(|| Arc::new(|_, _, _| {})),
            in_batch: options.in_batch,
            registry: self.arc(),
        }
    }

    /// Full execution path: gate, validate, run, normalise errors.
    pub fn run<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        options: RunOptions,
    ) -> BoxFuture<'a, Result<Outcome>> {
        async move {
            let Some(def) = self.tools.get(name) else {
                // Hidden tools stay out of this list too.
                let visible: Vec<&str> = self
                    .order
                    .iter()
                    .copied()
                    .filter(|n| self.services.config.allow_destructive || !self.is_destructive(n))
                    .collect();
                return Err(ToolError::new(format!("Unknown tool \"{name}\"."))
                    .code("UNKNOWN_TOOL")
                    .hint(format!("Available tools: {}", visible.join(", ")))
                    .into());
            };

            if def.destructive && !self.services.config.allow_destructive {
                return Err(destructive_disabled(name));
            }

            let parsed = self.parse(def, args)?;
            let ctx = self.context(&options);

            let arrays: Vec<&str> = def
                .bulk_args
                .iter()
                .copied()
                .filter(|a| parsed.get(*a).is_some_and(Value::is_array))
                .collect();
            if arrays.len() > 1 {
                return Err(ToolError::new(format!(
                    "Only one of {} may be an array in a single call.",
                    arrays.join(", ")
                ))
                .code("INVALID_ARGS")
                .hint("Split the call, or use discord_batch to combine different fan-outs.")
                .into());
            }

            if let Some(bulk_arg) = arrays.first() {
                let values = parsed
                    .get(*bulk_arg)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                return self
                    .run_bulk(def, Args(parsed), bulk_arg, values, ctx)
                    .await;
            }

            self.run_one(def, Args(parsed), ctx).await
        }
        .boxed()
    }

    async fn run_one(&self, def: &ToolDef, args: Args, ctx: Ctx) -> Result<Outcome> {
        // Each call runs as its own task, so a dropped caller never abandons a write halfway.
        let task = tokio::spawn((def.handler)(args, ctx));
        let result = task
            .await
            .unwrap_or_else(|e| Err(Error::Other(format!("tool task failed: {e}"))));
        result.map_err(|e| self.normalize(def, &e))
    }

    fn title_context(&self, def: &ToolDef) -> String {
        self.metas
            .get(def.name)
            .map_or_else(|| def.name.to_string(), |m| m.title.to_lowercase())
    }

    fn normalize(&self, def: &ToolDef, error: &Error) -> Error {
        let normalized = normalize_error(error, &self.title_context(def));
        if normalized.code == Some(Code::Num(50013))
            && let Some(hint) = def.missing_permission_hint
        {
            return ToolError {
                message: normalized.message,
                code: normalized.code,
                hint: Some(hint.to_string()),
            }
            .into();
        }
        normalized.into()
    }

    /// Fans one call out over an array bulk argument. A tool's bulk handler gets
    /// the first chance; otherwise repeats of one value run in sequence while
    /// distinct values run together. Each item reports its own result.
    async fn run_bulk(
        &self,
        def: &ToolDef,
        args: Args,
        bulk_arg: &str,
        values: Vec<Value>,
        ctx: Ctx,
    ) -> Result<Outcome> {
        let mut items: Option<Vec<BulkItem>> = None;

        if let Some(bulk) = def.bulk_handler
            && values.iter().all(Value::is_string)
        {
            let strings = crate::json::strings(&values);
            let task = tokio::spawn(bulk(
                args.clone(),
                bulk_arg.to_string(),
                strings,
                ctx.clone(),
            ));
            let r = task
                .await
                .unwrap_or_else(|e| Err(Error::Other(format!("tool task failed: {e}"))));
            items = r.map_err(|e| self.normalize(def, &e))?;
        }

        let items = match items {
            Some(items) => items,
            None => self.fan_out(def, &args, bulk_arg, values, &ctx).await,
        };

        let data: Vec<Value> = items
            .iter()
            .map(|item| {
                let mut row = Map::new();
                row.insert(bulk_arg.to_string(), item.value.clone());
                row.insert("ok".into(), item.ok.into());
                if item.ok {
                    if let Some(s) = &item.summary {
                        row.insert("summary".into(), s.clone().into());
                    }
                    if let Some(d) = &item.data {
                        row.insert("data".into(), d.clone());
                    }
                } else if let Some(e) = &item.error {
                    row.insert("error".into(), e.clone().into());
                }
                Value::Object(row)
            })
            .collect();

        let succeeded = items.iter().filter(|i| i.ok).count();
        let failed = items.len() - succeeded;
        let kind = if failed == 0 {
            None
        } else if succeeded == 0 {
            Some(Failed::All)
        } else {
            Some(Failed::Some)
        };

        Ok(Outcome {
            summary: format!(
                "{} on {} items: {succeeded} succeeded{}",
                def.name,
                items.len(),
                if failed > 0 {
                    format!(", {failed} failed.")
                } else {
                    ".".into()
                }
            ),
            data: Some(Value::Array(data)),
            failed: kind,
        })
    }

    async fn fan_out(
        &self,
        def: &ToolDef,
        args: &Args,
        bulk_arg: &str,
        values: Vec<Value>,
        ctx: &Ctx,
    ) -> Vec<BulkItem> {
        // Lanes keyed by value: repeats of one value run in sequence.
        let mut lane_keys: Vec<String> = Vec::new();
        let mut lanes: Vec<Vec<(usize, Value)>> = Vec::new();
        for (index, value) in values.iter().enumerate() {
            let key = value
                .as_str()
                .map_or_else(|| index.to_string(), str::to_string);
            match lane_keys.iter().position(|k| *k == key) {
                Some(i) => lanes[i].push((index, value.clone())),
                None => {
                    lane_keys.push(key);
                    lanes.push(vec![(index, value.clone())]);
                }
            }
        }

        let total = values.len() as u64;
        let done = std::sync::atomic::AtomicU64::new(0);
        // Inside a batch the batch's own lanes already run in parallel.
        let limit = if ctx.in_batch {
            1
        } else {
            ctx.config.batch_concurrency
        };
        let cancel = ctx.cancel.clone();
        let lane_entries = lanes.clone();
        let results = map_lanes(
            lanes,
            limit,
            |(_, value): (usize, Value)| {
                let args = args.with(bulk_arg, value);
                let ctx = ctx.clone();
                let done = &done;
                async move {
                    let r = self.run_one(def, args, ctx.clone()).await;
                    let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    (ctx.progress)(n, total, None);
                    r
                }
            },
            false,
            Some(&cancel),
        )
        .await;

        let mut items: Vec<Option<BulkItem>> = vec![None; values.len()];
        for (lane, settled) in lane_entries.iter().zip(results) {
            for ((index, value), r) in lane.iter().zip(settled) {
                items[*index] = Some(match r {
                    Ok(o) => BulkItem {
                        value: value.clone(),
                        ok: true,
                        summary: Some(o.summary),
                        data: o.data,
                        error: None,
                    },
                    Err(e) => BulkItem::err(value.clone(), error_text(&e)),
                });
            }
        }
        items
            .into_iter()
            .enumerate()
            .map(|(i, item)| item.unwrap_or_else(|| BulkItem::err(values[i].clone(), "Not run.")))
            .collect()
    }

    fn validator(&self, name: &str) -> Result<Arc<jsonschema::Validator>> {
        let mut map = self
            .validators
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(v) = map.get(name) {
            return Ok(Arc::clone(v));
        }
        let schema = Value::Object(
            self.metas
                .get(name)
                .map(|m| m.input_schema.clone())
                .unwrap_or_default(),
        );
        let validator = jsonschema::draft7::options()
            .should_validate_formats(true)
            .build(&schema)
            .map_err(|e| Error::Other(format!("invalid schema for {name}: {e}")))?;
        let validator = Arc::new(validator);
        map.insert(name.to_string(), Arc::clone(&validator));
        Ok(validator)
    }

    /// Validates arguments against the advertised schema, applies its defaults
    /// and drops unknown nested keys (zod's behaviour), then runs the checks a
    /// schema cannot express.
    fn parse(&self, def: &ToolDef, args: Value) -> Result<Obj> {
        let args = if args.is_null() {
            Value::Object(Obj::new())
        } else {
            args
        };
        let validator = self.validator(def.name)?;
        let mut issues: Vec<String> = validator
            .iter_errors(&args)
            .map(|e| format!("{}: {}", pointer_to_path(&e.instance_path().to_string()), e))
            .collect();

        let schema = Value::Object(
            self.metas
                .get(def.name)
                .map(|m| m.input_schema.clone())
                .unwrap_or_default(),
        );
        let parsed = if issues.is_empty() {
            apply_schema(&args, &schema)
        } else {
            args.clone()
        };
        let parsed = parsed.as_object().cloned().unwrap_or_default();

        if issues.is_empty()
            && let Some(check) = def.extra_check
        {
            issues.extend(check(&parsed).into_iter().map(|(path, message)| {
                format!(
                    "{}: {message}",
                    if path.is_empty() {
                        "(root)".into()
                    } else {
                        path
                    }
                )
            }));
        }

        if !issues.is_empty() {
            let fields: Vec<String> = schema
                .get("properties")
                .and_then(Value::as_object)
                .map(|p| p.keys().cloned().collect())
                .unwrap_or_default();
            return Err(ToolError::new(format!(
                "Invalid arguments for {}: {}",
                def.name,
                issues.join("; ")
            ))
            .code("INVALID_ARGS")
            .hint(format!("Expected fields: {}", fields.join(", ")))
            .into());
        }
        Ok(parsed)
    }
}

/// "/operations/0/tool" -> "operations.0.tool"; "" -> "(root)".
fn pointer_to_path(pointer: &str) -> String {
    let path = pointer
        .trim_start_matches('/')
        .split('/')
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect::<Vec<_>>()
        .join(".");
    if path.is_empty() {
        "(root)".into()
    } else {
        path
    }
}

/// The value as zod would output it: defaults filled in, keys in schema order,
/// unknown keys of non-strict nested objects dropped.
fn apply_schema(value: &Value, schema: &Value) -> Value {
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        let branch = branches.iter().find(|b| type_matches(value, b));
        return branch.map_or_else(|| value.clone(), |b| apply_schema(value, b));
    }
    match value {
        Value::Object(map) => {
            let Some(props) = schema.get("properties").and_then(Value::as_object) else {
                return value.clone();
            };
            let open = schema
                .get("additionalProperties")
                .is_some_and(|a| a.is_object() || a == &Value::Bool(true));
            let mut out = Map::new();
            for (key, prop) in props {
                match map.get(key) {
                    Some(v) => {
                        out.insert(key.clone(), apply_schema(v, prop));
                    }
                    None => {
                        if let Some(default) = prop.get("default") {
                            out.insert(key.clone(), apply_schema(default, prop));
                        }
                    }
                }
            }
            if open {
                for (k, v) in map {
                    if !out.contains_key(k) {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => match schema.get("items") {
            Some(item_schema) => {
                Value::Array(items.iter().map(|i| apply_schema(i, item_schema)).collect())
            }
            None => value.clone(),
        },
        _ => value.clone(),
    }
}

fn type_matches(value: &Value, schema: &Value) -> bool {
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_number(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => schema.get("const").is_none_or(|c| c == value),
    }
}

/// Renders an outcome into the MCP tool result parts: (text, structuredContent, isError).
pub fn render_outcome(outcome: &Outcome, max_chars: usize) -> (String, Option<Value>, bool) {
    let summary = clip_summary(&outcome.summary, max_chars);
    let is_error = outcome.failed == Some(Failed::All);
    let Some(data) = &outcome.data else {
        return (summary, None, is_error);
    };

    let budget =
        (max_chars as i64 - crate::js::len16(&summary) as i64 - 160).max(MIN_DATA_BUDGET) as usize;
    let fitted = fit_to_budget(data, budget);
    let notice = describe_trim(fitted.stats);
    let text = match notice {
        Some(n) => format!("{summary}\n{}\n{n}", fitted.text),
        None => format!("{summary}\n{}", fitted.text),
    };
    let structured = if fitted.value.is_object() {
        fitted.value
    } else {
        serde_json::json!({ "result": fitted.value })
    };
    (text, Some(structured), is_error)
}

/// Smallest data budget a render gets, however long the summary is.
const MIN_DATA_BUDGET: i64 = 200;

/// Renders a failure as error text rather than a protocol-level error.
pub fn render_error(error: &Error, context: &str) -> String {
    match error {
        Error::Tool(t) => t.to_text(),
        other => normalize_error(other, context).to_text(),
    }
}

#[cfg(test)]
pub mod tests;
