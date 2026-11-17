//! Shrinks arbitrary JSON data until it serialises within a character budget.
//!
//! The budget is shared out ("water-filled") across siblings, so every entry
//! keeps its identity and only the largest ones give up detail. Only when a
//! list is so long that each item would be reduced to a stub are trailing items
//! dropped - and then counted, so the agent knows to narrow its query.
//! Sizes are JSON text lengths in UTF-16 units, as in the original.

use crate::js::{len16, prefix16, stringify};
use serde_json::{Map, Value};

/// Below this per-item share, dropping trailing items beats mangling them all.
const MIN_ITEM_SHARE: i64 = 200;

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct FitStats {
    /// List items dropped from the end of an array.
    pub omitted: usize,
    /// Strings shortened to fit.
    pub clipped: usize,
}

pub struct Fitted {
    pub value: Value,
    pub text: String,
    pub stats: FitStats,
}

fn size(value: &Value) -> i64 {
    len16(&stringify(value)) as i64
}

pub fn fit_to_budget(data: &Value, budget: usize) -> Fitted {
    let budget = budget as i64;
    let mut stats = FitStats::default();
    let value = shrink(data, budget.max(16), &mut stats);
    let mut text = stringify(&value);

    // Last-resort guarantee for shapes the heuristics could not reduce.
    if len16(&text) as i64 > budget {
        text = format!("{}\u{2026}", prefix16(&text, (budget - 1).max(0) as usize));
        stats.clipped += 1;
    }

    Fitted { value, text, stats }
}

fn shrink(value: &Value, budget: i64, stats: &mut FitStats) -> Value {
    let total = size(value);
    if total <= budget {
        return value.clone();
    }
    match value {
        Value::String(s) => {
            stats.clipped += 1;
            // Quotes and escapes cost characters too; aim a little under.
            let room = (budget - 3 - (total - len16(s) as i64 - 2)).max(0);
            Value::String(format!("{}\u{2026}", prefix16(s, room as usize)))
        }
        Value::Array(items) => Value::Array(shrink_array(items, budget, stats)),
        Value::Object(map) => Value::Object(shrink_object(map, budget, stats)),
        _ => value.clone(),
    }
}

fn shrink_array(items: &[Value], budget: i64, stats: &mut FitStats) -> Vec<Value> {
    let sizes: Vec<i64> = items.iter().map(size).collect();
    let available = budget - 2 - (items.len() as i64 - 1).max(0);

    let cap = water_level(&sizes, available);
    if cap >= MIN_ITEM_SHARE {
        let mut trial = FitStats::default();
        let shared: Vec<Value> = items
            .iter()
            .zip(&sizes)
            .map(|(item, &s)| {
                if s > cap {
                    shrink(item, cap, &mut trial)
                } else {
                    item.clone()
                }
            })
            .collect();
        // The original counts clips made on this attempt even when it is then abandoned.
        stats.omitted += trial.omitted;
        stats.clipped += trial.clipped;
        if size(&Value::Array(shared.clone())) <= budget {
            return shared;
        }
    }

    // Too many items to share the budget sensibly: keep the longest prefix.
    let mut used = 2;
    let mut kept = 0usize;
    for &s in &sizes {
        let cost = s + i64::from(kept > 0);
        if used + cost > budget {
            break;
        }
        used += cost;
        kept += 1;
    }

    if kept == 0 && !items.is_empty() {
        // Not even one whole item fits; keep a reduced first item rather than nothing.
        stats.omitted += items.len() - 1;
        return vec![shrink(&items[0], budget - 2, stats)];
    }

    stats.omitted += items.len() - kept;
    items[..kept].to_vec()
}

fn shrink_object(
    source: &Map<String, Value>,
    budget: i64,
    stats: &mut FitStats,
) -> Map<String, Value> {
    let mut out = source.clone();
    let keys: Vec<String> = out.keys().cloned().collect();
    let sizes: Vec<i64> = keys.iter().map(|k| size(&out[k])).collect();

    // Key names, quotes, colons and commas are fixed overhead.
    let skeleton: Map<String, Value> = keys.iter().map(|k| (k.clone(), Value::from(0))).collect();
    let overhead = size(&Value::Object(skeleton)) - keys.len() as i64;
    let cap = water_level(&sizes, budget - overhead);

    for (key, &s) in keys.iter().zip(&sizes) {
        if s > cap {
            let shrunk = shrink(&out[key], cap.max(16), stats);
            out.insert(key.clone(), shrunk);
        }
    }
    out
}

/// The largest per-item cap `c` such that sum(min(size, c)) <= available.
/// i64::MAX stands in for "no cap needed".
fn water_level(sizes: &[i64], available: i64) -> i64 {
    if sizes.is_empty() {
        return available;
    }
    let mut sorted = sizes.to_vec();
    sorted.sort_unstable();
    let mut remaining = available;
    let n = sorted.len() as i64;
    for (i, &s) in sorted.iter().enumerate() {
        let share = remaining.div_euclid(n - i as i64);
        if s > share {
            return share;
        }
        remaining -= s;
    }
    i64::MAX
}

/// Caps a one-line summary at a quarter of the response budget.
pub fn clip_summary(summary: &str, max_chars: usize) -> String {
    crate::js::clip(summary, max_chars / 4)
}

/// Human note describing what fitting removed, or None when nothing was.
pub fn describe_trim(stats: FitStats) -> Option<String> {
    if stats.omitted == 0 && stats.clipped == 0 {
        return None;
    }
    let mut parts = Vec::new();
    if stats.omitted > 0 {
        parts.push(format!("{} list item(s) omitted", stats.omitted));
    }
    if stats.clipped > 0 {
        parts.push(format!("{} long value(s) clipped", stats.clipped));
    }
    Some(format!(
        "[Output trimmed to fit the context budget: {}. Use a smaller limit or a filter to see the rest.]",
        parts.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_data_untouched() {
        let f = fit_to_budget(&json!({"a": 1}), 100);
        assert_eq!(f.text, r#"{"a":1}"#);
        assert_eq!(f.stats, FitStats::default());
    }

    #[test]
    fn long_list_keeps_every_item_identity() {
        let items: Vec<Value> = (0..20)
            .map(|i| json!({"id": i, "text": "x".repeat(2000)}))
            .collect();
        let f = fit_to_budget(&Value::Array(items), 25_000);
        assert!(len16(&f.text) <= 25_000);
        assert_eq!(f.value.as_array().unwrap().len(), 20);
        assert!(f.stats.clipped > 0);
    }

    #[test]
    fn huge_list_drops_tail() {
        let items: Vec<Value> = (0..2000)
            .map(|i| json!({"id": i, "t": "y".repeat(50)}))
            .collect();
        let f = fit_to_budget(&Value::Array(items), 5_000);
        assert!(len16(&f.text) <= 5_000);
        assert!(f.stats.omitted > 0);
        assert!(
            describe_trim(f.stats)
                .unwrap()
                .contains("list item(s) omitted")
        );
    }

    #[test]
    fn water_level_math() {
        assert_eq!(water_level(&[10, 10], 100), i64::MAX);
        assert_eq!(water_level(&[10, 100], 50), 40);
    }
}
