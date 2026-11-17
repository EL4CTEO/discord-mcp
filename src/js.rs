//! JavaScript-compatible string helpers.
//!
//! The original server measured and cut text in UTF-16 code units (JS string
//! semantics), trimmed with the JS whitespace set and matched `\w`/`\d` as
//! ASCII. Discord's own limits are counted the same way, so these helpers keep
//! every length check and every clip landing exactly where it did before.

/// Length in UTF-16 code units, as `String.prototype.length` reports it.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Byte offset of the UTF-16 offset `units`, rounded down so a surrogate pair
/// is never split (a Rust string cannot hold half of one).
fn byte_at16(s: &str, units: usize) -> usize {
    let mut seen = 0;
    for (index, c) in s.char_indices() {
        let next = seen + c.len_utf16();
        if next > units {
            return index;
        }
        seen = next;
    }
    s.len()
}

/// `s.slice(0, units)`.
pub fn prefix16(s: &str, units: usize) -> &str {
    &s[..byte_at16(s, units)]
}

/// Clamp long free text so one noisy message cannot eat the context window.
pub fn clip(text: &str, max: usize) -> String {
    if len16(text) <= max {
        return text.to_string();
    }
    // Rounding down at a pair boundary is exactly the original's
    // "never end on a lone high surrogate" step.
    format!("{}\u{2026}", prefix16(text, max.saturating_sub(1)))
}

/// The characters JS `trim()` and `\s` treat as whitespace.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Regex class equivalent to JS `\s`.
pub const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `JSON.stringify`, compact. Object keys keep insertion order (serde_json's
/// `preserve_order`), like a JS object.
pub fn stringify(value: &serde_json::Value) -> String {
    // INFALLIBLE: a serde_json::Value always serialises (its map keys are strings).
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// `Number(text)` for an environment variable: decimal, exponent, hex/octal/binary
/// prefixes and Infinity; anything else is NaN.
pub fn number(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        u128::from_str_radix(digits, base).map_or(f64::NAN, |v| v as f64)
    };
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("0x") {
        return radix(rest, 16);
    }
    if let Some(rest) = lower.strip_prefix("0o") {
        return radix(rest, 8);
    }
    if let Some(rest) = lower.strip_prefix("0b") {
        return radix(rest, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !valid || lower.contains("inf") || lower.contains("nan") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const SET: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(s, SET).to_string()
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `Date.parse(text)` for the ISO 8601 shapes Discord and the tools use; NaN otherwise.
pub fn parse_date_ms(text: &str) -> f64 {
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(text) {
        return d.timestamp_millis() as f64;
    }
    // ISO without a zone is local time in JS; Discord never sends that, and UTC is the safe reading.
    if let Ok(d) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        return d.and_utc().timestamp_millis() as f64;
    }
    f64::NAN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_lengths_and_slices() {
        assert_eq!(len16("a😀b"), 4);
        assert_eq!(prefix16("a😀b", 2), "a");
        assert_eq!(prefix16("a😀b", 3), "a😀");
    }

    #[test]
    fn clip_never_splits_a_pair() {
        assert_eq!(clip("hello", 5), "hello");
        assert_eq!(clip("hello!", 5), "hell\u{2026}");
        assert_eq!(clip("ab😀cd", 4), "ab\u{2026}");
    }

    #[test]
    fn js_number() {
        assert_eq!(number("15000"), 15000.0);
        assert_eq!(number(" 12 "), 12.0);
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("1e3"), 1000.0);
        assert!(number("abc").is_nan());
        assert!(number("Infinity").is_infinite());
    }

    #[test]
    fn uri_component() {
        assert_eq!(encode_uri_component("a b/✅"), "a%20b%2F%E2%9C%85");
        assert_eq!(encode_uri_component("name:123"), "name%3A123");
    }

    #[test]
    fn js_trim_set() {
        assert_eq!(trim("\u{feff} x \u{a0}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }
}
