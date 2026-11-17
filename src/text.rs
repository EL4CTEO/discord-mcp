//! Message splitting and emoji parsing.

use regex::Regex;
use std::sync::LazyLock;

/// Discord's hard limit for the content of one message.
pub const MESSAGE_LIMIT: usize = 2000;

/// Longest fence header ("```typescript") worth carrying into the next chunk.
const MAX_FENCE_HEADER: usize = 24;

fn is_space16(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(crate::js::is_js_space)
}

fn trim_end16(s: &[u16]) -> &[u16] {
    let mut end = s.len();
    while end > 0 && is_space16(s[end - 1]) {
        end -= 1;
    }
    &s[..end]
}

fn trim_start16(s: &[u16]) -> &[u16] {
    let mut start = 0;
    while start < s.len() && is_space16(s[start]) {
        start += 1;
    }
    &s[start..]
}

fn last_index_of(hay: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .rev()
        .find(|&i| &hay[i..i + needle.len()] == needle)
}

fn to_string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Splits text into chunks Discord will accept, breaking at the most natural
/// boundary available: a blank line, then a line break, then a space, and only
/// as a last resort mid-word. Code fences are closed at a split and reopened
/// with the same language tag in the next chunk.
pub fn split_message(text: &str, limit: usize) -> Vec<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= limit {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut rest: &[u16] = &units;
    let mut reopen: Vec<u16> = Vec::new();

    while !rest.is_empty() {
        let room = limit.saturating_sub(reopen.len());
        if rest.len() <= room {
            let mut chunk = reopen.clone();
            chunk.extend_from_slice(rest);
            chunks.push(to_string(&chunk));
            break;
        }

        // Keep 4 characters spare for a closing "\n```".
        let window = &rest[..room.saturating_sub(4).min(rest.len())];
        let (cut, skip) = break_point(window);

        let mut chunk = reopen.clone();
        chunk.extend_from_slice(trim_end16(&rest[..cut]));
        rest = &rest[(cut + skip).min(rest.len())..];

        match open_fence(&chunk) {
            None => reopen.clear(),
            Some(fence) => {
                chunk.extend("\n```".encode_utf16());
                reopen = if fence.len() > MAX_FENCE_HEADER {
                    "```".encode_utf16().collect()
                } else {
                    fence
                };
                reopen.push(u16::from(b'\n'));
            }
        }

        if !trim_start16(trim_end16(&chunk)).is_empty() {
            chunks.push(to_string(&chunk));
        }
    }

    chunks
}

/// Where to cut `window`, and how many separator characters to drop after it.
fn break_point(window: &[u16]) -> (usize, usize) {
    let floor = window.len() / 2;
    let nl = u16::from(b'\n');

    if let Some(p) = last_index_of(window, &[nl, nl]).filter(|&p| p >= floor) {
        return (p, 2);
    }
    if let Some(p) = last_index_of(window, &[nl]).filter(|&p| p >= floor) {
        return (p, 1);
    }
    if let Some(p) = last_index_of(window, &[u16::from(b' ')]).filter(|&p| p >= floor) {
        return (p, 1);
    }

    // Hard cut - but never between the two halves of a surrogate pair.
    let mut cut = window.len();
    if cut > 0 && (0xd800..=0xdbff).contains(&window[cut - 1]) {
        cut -= 1;
    }
    (cut, 0)
}

/// The header line of a ``` fence left open at the end of `chunk`, if any.
fn open_fence(chunk: &[u16]) -> Option<Vec<u16>> {
    let tick = u16::from(b'`');
    let mut open: Option<Vec<u16>> = None;
    for line in chunk.split(|&u| u == u16::from(b'\n')) {
        let trimmed = trim_start16(line);
        if trimmed.len() < 3 || trimmed[..3] != [tick, tick, tick] {
            continue;
        }
        open = match open {
            None => Some(
                trimmed
                    .iter()
                    .copied()
                    .take_while(|&u| !is_space16(u))
                    .collect(),
            ),
            Some(_) => None,
        };
    }
    open
}

static CUSTOM_EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^<a?:([A-Za-z0-9_]{2,32}):([0-9]{17,20})>$").expect("valid regex")
});
static NAME_ID_EMOJI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_]{2,32}):([0-9]{17,20})$").expect("valid regex"));
static BARE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:?([A-Za-z0-9_]{2,32}):?$").expect("valid regex"));

/// An emoji reference: a reaction route segment, or a bare custom-emoji name to look up.
#[derive(Debug, PartialEq, Eq)]
pub enum EmojiRef {
    Route(String),
    Lookup(String),
}

/// Accepts every shape people paste: '✅', 'name:id', '<:name:id>', '<a:name:id>',
/// and ':name:' or 'name' for a server emoji.
pub fn parse_emoji(input: &str) -> EmojiRef {
    let trimmed = crate::js::trim(input);

    if let Some(c) = CUSTOM_EMOJI
        .captures(trimmed)
        .or_else(|| NAME_ID_EMOJI.captures(trimmed))
    {
        return EmojiRef::Route(format!("{}:{}", &c[1], &c[2]));
    }

    if let Some(c) = BARE_NAME.captures(trimmed) {
        let name = &c[1];
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            return EmojiRef::Lookup(name.to_string());
        }
    }

    EmojiRef::Route(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(split_message("hi", 2000), vec!["hi"]);
    }

    #[test]
    fn splits_at_paragraphs() {
        let text = format!("{}\n\n{}", "a".repeat(1500), "b".repeat(1500));
        let parts = split_message(&text, 2000);
        assert_eq!(parts, vec!["a".repeat(1500), "b".repeat(1500)]);
    }

    #[test]
    fn code_fences_survive() {
        let body = (0..300)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!("```rust\n{body}\n```");
        let parts = split_message(&text, 2000);
        assert!(parts.len() > 1);
        for p in &parts {
            assert!(crate::js::len16(p) <= 2000);
            assert_eq!(p.matches("```").count() % 2, 0, "{p}");
        }
        assert!(parts[1].starts_with("```rust\n"));
    }

    #[test]
    fn hard_cut_keeps_emoji_whole() {
        let text = "😀".repeat(1500);
        let parts = split_message(&text, 2000);
        assert_eq!(parts.concat(), text);
    }

    #[test]
    fn emoji_shapes() {
        assert_eq!(parse_emoji("✅"), EmojiRef::Route("✅".into()));
        assert_eq!(
            parse_emoji("<:party:123456789012345678>"),
            EmojiRef::Route("party:123456789012345678".into())
        );
        assert_eq!(
            parse_emoji("<a:party:123456789012345678>"),
            EmojiRef::Route("party:123456789012345678".into())
        );
        assert_eq!(parse_emoji(":party:"), EmojiRef::Lookup("party".into()));
        assert_eq!(parse_emoji("12345"), EmojiRef::Route("12345".into()));
    }
}
