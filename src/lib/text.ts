/** Discord's hard limit for the content of one message. */
export const MESSAGE_LIMIT = 2000;

/** Longest fence header ("```typescript") worth carrying into the next chunk. */
const MAX_FENCE_HEADER = 24;

/**
 * Splits text into chunks Discord will accept, breaking at the most natural
 * boundary available: a blank line, then a line break, then a space, and only
 * as a last resort mid-word.
 *
 * Code blocks survive the split. A chunk that ends inside a ``` fence is
 * closed, and the next chunk reopens it with the same language tag, so a long
 * code sample renders as several highlighted blocks instead of leaking raw
 * backticks into the text around it.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  let reopen = "";

  while (rest.length > 0) {
    const room = limit - reopen.length;
    if (rest.length <= room) {
      chunks.push(reopen + rest);
      break;
    }

    // Keep 4 characters spare for a closing "\n```".
    const window = rest.slice(0, room - 4);
    const { cut, skip } = breakPoint(window);

    let chunk = reopen + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut + skip);

    const fence = openFence(chunk);
    if (fence === undefined) {
      reopen = "";
    } else {
      chunk += "\n```";
      reopen = `${fence.length > MAX_FENCE_HEADER ? "```" : fence}\n`;
    }

    if (chunk.trim().length > 0) chunks.push(chunk);
  }

  return chunks;
}

/** Where to cut `window`, and how many separator characters to drop after it. */
function breakPoint(window: string): { cut: number; skip: number } {
  const floor = Math.floor(window.length / 2);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= floor) return { cut: paragraph, skip: 2 };

  const line = window.lastIndexOf("\n");
  if (line >= floor) return { cut: line, skip: 1 };

  const space = window.lastIndexOf(" ");
  if (space >= floor) return { cut: space, skip: 1 };

  // Hard cut - but never between the two halves of a surrogate pair, which
  // would leave a broken emoji on both sides.
  let cut = window.length;
  const code = window.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { cut, skip: 0 };
}

/** The header line of a ``` fence left open at the end of `chunk`, if any. */
function openFence(chunk: string): string | undefined {
  let open: string | undefined;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("```")) continue;
    open = open === undefined ? trimmed.split(/\s/)[0] : undefined;
  }
  return open;
}

const CUSTOM_EMOJI = /^<a?:(\w{2,32}):(\d{17,20})>$/;
const NAME_ID_EMOJI = /^(\w{2,32}):(\d{17,20})$/;
const BARE_NAME = /^:?(\w{2,32}):?$/;

/**
 * Classifies an emoji reference as a reaction route segment, or as a bare
 * custom-emoji name that still has to be looked up in the server.
 *
 * Accepts every shape people paste: '✅', 'name:id', '<:name:id>',
 * '<a:name:id>' (animated), and ':name:' or 'name' for a server emoji.
 */
export function parseEmoji(input: string): { route: string } | { lookup: string } {
  const trimmed = input.trim();

  const custom = CUSTOM_EMOJI.exec(trimmed) ?? NAME_ID_EMOJI.exec(trimmed);
  if (custom) return { route: `${custom[1]}:${custom[2]}` };

  const bare = BARE_NAME.exec(trimmed);
  if (bare?.[1] && !/^\d+$/.test(bare[1])) return { lookup: bare[1] };

  return { route: trimmed };
}
