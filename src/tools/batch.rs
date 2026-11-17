//! discord_batch: several different tool calls in one request, in parallel
//! within Discord's rate limits.

use super::util::plural;
use super::{Args, Ctx, Failed, Outcome, ToolDef};
use crate::errors::{Error, Result, ToolError, error_text};
use crate::limiter::map_lanes;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// Most Discord calls one batch may make once fan-outs are expanded.
const MAX_CALLS: usize = 100;
/// Failed items a batch error spells out before summarising the rest.
const DETAIL_ITEMS: usize = 10;
/// Keys a fan-out result row uses for itself, as opposed to the bulk argument's value.
const ROW_KEYS: &[&str] = &["ok", "error", "summary", "data"];

/// One operation in a lane: (index in the batch, tool, args).
type Op = (usize, String, Map<String, Value>);

pub fn batch() -> ToolDef {
    ToolDef::new("discord_batch", batch_handler)
}

/// Merges batch-level defaults into one operation's args, only for keys that tool accepts.
fn with_defaults(
    ctx: &Ctx,
    tool: &str,
    args: &Map<String, Value>,
    defaults: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut merged = args.clone();
    if let Some(defaults) = defaults {
        for (key, value) in defaults {
            if !merged.contains_key(key) && ctx.accepts(tool, key) {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged
}

/// Discord calls one operation expands to: its longest bulk array, or 1.
fn fan_out_size(args: &Map<String, Value>, bulk_args: &[&str]) -> usize {
    bulk_args
        .iter()
        .filter_map(|a| args.get(*a).and_then(Value::as_array))
        .map(Vec::len)
        .fold(1, usize::max)
}

/// Compact list of a fan-out's failed items, so a failed operation still says which items broke and why.
fn failure_detail(outcome: &Outcome) -> String {
    let rows: Vec<&Value> = outcome
        .data
        .as_ref()
        .and_then(Value::as_array)
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    let failures: Vec<&&Value> = rows
        .iter()
        .filter(|r| r.get("ok") == Some(&Value::Bool(false)))
        .collect();
    let lines: Vec<String> = failures
        .iter()
        .take(DETAIL_ITEMS)
        .map(|row| {
            let item = row.as_object().and_then(|m| {
                m.iter()
                    .find(|(k, _)| !ROW_KEYS.contains(&k.as_str()))
                    .map(|(_, v)| v.clone())
            });
            let value = match &item {
                Some(Value::String(s)) => s.clone(),
                Some(other) => crate::js::stringify(other),
                None => "undefined".into(),
            };
            let error = row
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("")
                .replace('\n', " ");
            format!("{value}: {error}")
        })
        .collect();
    let more = failures.len() - lines.len();
    format!(
        "Failed items: {}{}",
        lines.join("; "),
        if more > 0 {
            format!("; and {more} more")
        } else {
            String::new()
        }
    )
}

/// Approximates the Discord rate-limit bucket an operation will use.
fn bucket_key(tool: &str, args: &Map<String, Value>) -> String {
    let major = args
        .get("channel")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            args.get("guild")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("");
    format!("{tool}|{major}")
}

fn batch_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let raw_ops = a.arr("operations").cloned().unwrap_or_default();
        if raw_ops
            .iter()
            .any(|op| op.get("tool").and_then(Value::as_str) == Some("discord_batch"))
        {
            return Err(
                ToolError::new("discord_batch cannot contain another discord_batch.")
                    .code("NESTED_BATCH")
                    .hint("Flatten the operations into a single list.")
                    .into(),
            );
        }

        let defaults = a.get("defaults").and_then(Value::as_object).cloned();
        let operations: Vec<(String, Map<String, Value>)> = raw_ops
            .iter()
            .map(|op| {
                let tool = op
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = op
                    .get("args")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let merged = with_defaults(&ctx, &tool, &args, defaults.as_ref());
                (tool, merged)
            })
            .collect();

        // Checked before anything runs, so an oversized batch changes nothing.
        let calls: usize = operations
            .iter()
            .map(|(tool, args)| fan_out_size(args, ctx.bulk_args(tool)))
            .sum();
        if calls > MAX_CALLS {
            return Err(ToolError::new(format!(
                "This batch would make {calls} Discord calls; the limit is {MAX_CALLS}."
            ))
            .code("TOO_MANY_CALLS")
            .hint("Split the work into several discord_batch calls.")
            .into());
        }

        // Group by the rate-limit bucket each operation will land in.
        let mut lane_keys: Vec<String> = Vec::new();
        let mut lanes: Vec<Vec<Op>> = Vec::new();
        for (index, (tool, args)) in operations.iter().enumerate() {
            let key = bucket_key(tool, args);
            match lane_keys.iter().position(|k| *k == key) {
                Some(i) => lanes[i].push((index, tool.clone(), args.clone())),
                None => {
                    lane_keys.push(key);
                    lanes.push(vec![(index, tool.clone(), args.clone())]);
                }
            }
        }

        let stop_on_error = a.bool("stop_on_error");
        let concurrency = a
            .i64("concurrency")
            .map_or(ctx.config.batch_concurrency, |c| c.max(1) as usize);
        let total = operations.len() as u64;
        let done = AtomicU64::new(0);
        let lane_index: Vec<Vec<usize>> = lanes
            .iter()
            .map(|l| l.iter().map(|(i, _, _)| *i).collect())
            .collect();

        // Routing through ctx.invoke gives every operation the same validation,
        // destructive gate and error normalisation as a direct call.
        let results = map_lanes(
            lanes,
            concurrency,
            |(_, tool, args): (usize, String, Map<String, Value>)| {
                let ctx = ctx.clone();
                let done = &done;
                async move {
                    let r: Result<Outcome> = async {
                        let outcome = ctx.invoke(tool.clone(), Value::Object(args)).await?;
                        // A fan-out where everything failed is a failed operation; a partial one only
                        // halts the batch when stop_on_error asks for that.
                        if outcome.failed == Some(Failed::All) {
                            return Err(Error::from(
                                ToolError::new(outcome.summary.clone())
                                    .code("ALL_FAILED")
                                    .hint(failure_detail(&outcome)),
                            ));
                        }
                        if outcome.failed == Some(Failed::Some) && stop_on_error {
                            return Err(ToolError::new(outcome.summary.clone())
                                .code("PARTIAL_FAILURE")
                                .hint(failure_detail(&outcome))
                                .into());
                        }
                        Ok(outcome)
                    }
                    .await;
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    (ctx.progress)(n, total, Some(tool));
                    r
                }
            },
            stop_on_error,
            Some(&ctx.cancel),
        )
        .await;

        // Flatten back into the caller's order, which lanes deliberately scrambled.
        let mut flat: Vec<Option<Result<Outcome>>> = (0..operations.len()).map(|_| None).collect();
        for (indexes, settled) in lane_index.iter().zip(results) {
            for (index, r) in indexes.iter().zip(settled) {
                flat[*index] = Some(r);
            }
        }

        let data: Vec<Value> = flat
            .into_iter()
            .enumerate()
            .map(|(index, r)| {
                let tool = operations[index].0.clone();
                let mut row = Map::new();
                row.insert("index".into(), index.into());
                row.insert("tool".into(), tool.into());
                match r {
                    Some(Ok(o)) => {
                        row.insert("ok".into(), true.into());
                        row.insert("summary".into(), o.summary.into());
                        if let Some(d) = o.data {
                            row.insert("data".into(), d);
                        }
                    }
                    Some(Err(e)) => {
                        row.insert("ok".into(), false.into());
                        row.insert("error".into(), error_text(&e).into());
                    }
                    None => {
                        row.insert("ok".into(), false.into());
                        row.insert("error".into(), "Not run.".into());
                    }
                }
                Value::Object(row)
            })
            .collect();

        let succeeded = data
            .iter()
            .filter(|d| d.get("ok") == Some(&Value::Bool(true)))
            .count();
        let failed = data.len() - succeeded;
        Ok(Outcome {
            summary: format!(
                "Batch finished: {succeeded}/{} succeeded{}",
                data.len(),
                if failed > 0 {
                    format!(", {}.", plural(failed, "failure"))
                } else {
                    ".".into()
                }
            ),
            data: Some(Value::Array(data)),
            failed: if failed == 0 {
                None
            } else if succeeded == 0 {
                Some(Failed::All)
            } else {
                Some(Failed::Some)
            },
        })
    })
}
