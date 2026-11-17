//! Errors that are safe and useful to hand back to an LLM.
//!
//! The `hint` is the important part: it tells the agent what to do next rather
//! than only what went wrong.

use std::fmt;

/// A ToolError code: a symbolic name, or a Discord/HTTP/close code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Code {
    Text(&'static str),
    Num(i64),
}

#[derive(Clone, Debug)]
pub struct ToolError {
    pub message: String,
    pub hint: Option<String>,
    pub code: Option<Code>,
}

impl ToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: None,
            code: None,
        }
    }

    pub fn code(mut self, code: &'static str) -> Self {
        self.code = Some(Code::Text(code));
        self
    }

    pub fn num(mut self, code: i64) -> Self {
        self.code = Some(Code::Num(code));
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn maybe_hint(mut self, hint: Option<String>) -> Self {
        self.hint = hint;
        self
    }

    pub fn is(&self, code: &str) -> bool {
        matches!(self.code, Some(Code::Text(c)) if c == code)
    }

    /// Multi-line rendering used as the tool text response on failure.
    pub fn to_text(&self) -> String {
        match &self.hint {
            Some(hint) if !hint.is_empty() => format!("{}\nHint: {}", self.message, hint),
            _ => self.message.clone(),
        }
    }
}

/// Everything a Discord call or a tool can fail with.
#[derive(Clone, Debug)]
pub enum Error {
    Tool(ToolError),
    /// Discord answered with a JSON error body.
    Api {
        status: u16,
        code: i64,
        message: String,
    },
    /// A non-2xx answer without a Discord error body.
    Http {
        status: u16,
        message: String,
    },
    /// Discord kept rate-limiting past the retry budget.
    RateLimit {
        seconds: u64,
        route: String,
    },
    /// The request was cancelled or timed out.
    Timeout,
    /// Any other failure (network, I/O), by message.
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<ToolError> for Error {
    fn from(error: ToolError) -> Self {
        Error::Tool(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&error_text(self))
    }
}

impl Error {
    pub fn tool(&self) -> Option<&ToolError> {
        match self {
            Error::Tool(t) => Some(t),
            _ => None,
        }
    }

    /// True for a ToolError with this symbolic code.
    pub fn is(&self, code: &str) -> bool {
        self.tool().is_some_and(|t| t.is(code))
    }

    /// The Discord JSON error code, for an API error.
    pub fn api_code(&self) -> Option<i64> {
        match self {
            Error::Api { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// Error text for a per-item failure report.
pub fn error_text(error: &Error) -> String {
    match error {
        Error::Tool(t) => t.to_text(),
        Error::Api { message, .. } | Error::Http { message, .. } | Error::Other(message) => {
            message.clone()
        }
        Error::RateLimit { seconds, route } => {
            format!("Rate limited for {seconds}s on route {route}.")
        }
        Error::Timeout => "This operation was aborted".to_string(),
    }
}

/// Raised by destructive tools when DISCORD_ALLOW_DESTRUCTIVE is not enabled.
pub fn destructive_disabled(action: &str) -> Error {
    ToolError::new(format!(
        "Refused: \"{action}\" is a destructive action and destructive actions are disabled."
    ))
    .code("DESTRUCTIVE_DISABLED")
    .hint(
        "Set DISCORD_ALLOW_DESTRUCTIVE=true in the MCP server environment and restart it. \
         It is off by default so an accidental call cannot ban members or delete channels.",
    )
    .into()
}

/// Discord JSON error codes mapped to what the agent should actually do next.
fn code_hint(code: i64) -> Option<&'static str> {
    Some(match code {
        10003 => {
            "That channel does not exist, or the bot is not in its server. Call discord_list_channels for valid channels."
        }
        10004 => {
            "The bot is not a member of that server. Call discord_list_guilds to see which servers it can reach."
        }
        10007 => {
            "That member is not in the server. Use discord_list_members with a search query to find the right person."
        }
        10008 => {
            "That message no longer exists, or it lives in a different channel than the one supplied."
        }
        10011 => "That role does not exist. Call discord_list_roles for valid roles.",
        10013 => "No Discord user has that ID.",
        10014 => {
            "Unknown emoji. Custom emojis must come from a server the bot is in; pass them as 'name:id' or '<:name:id>'."
        }
        10026 => "That user is not banned, so there is nothing to unban.",
        20001 => "This endpoint is for user accounts only and can never be used by a bot.",
        20022 => "This announcement channel hit its edit rate limit. Wait a few minutes.",
        20028 => "The channel slowmode limit was hit. Send more slowly, or lower the slowmode.",
        30003 => "This channel already has the maximum of 50 pinned messages. Unpin one first.",
        30005 => "The server already has the maximum of 250 roles.",
        30013 => "The server already has the maximum of 500 channels.",
        30016 => "The server has hit its invite limit.",
        30007 => "The server already has the maximum number of webhooks for this channel.",
        30010 => "This message already has the maximum of 20 different reaction emojis.",
        40005 => {
            "The upload is too large. Bots may send up to 10 MB per message unless the server is boosted."
        }
        40007 => "That user is already banned from this server.",
        50001 => {
            "The bot cannot see that resource. Invite it to the server, or grant its role View Channel on that channel."
        }
        50005 => "A bot can only edit its own messages. Post a new message instead.",
        50006 => {
            "Discord rejected an empty message. Supply content, at least one embed, or a file."
        }
        50007 => "That user has DMs from server members turned off, or has blocked the bot.",
        50013 => {
            "The bot is missing a permission. Check its role has the needed permission and, for role/kick/ban actions, that the bot highest role sits ABOVE the target user highest role in Server Settings -> Roles."
        }
        50019 => "System messages (pins, joins, boosts) cannot be modified.",
        50021 => "Actions cannot be performed on a system message.",
        50024 => {
            "That action is not valid for this channel type (for example reading history from a category or voice channel)."
        }
        50034 => {
            "Bulk delete only works on messages newer than 14 days. Remove older ones individually with discord_delete_message."
        }
        50035 => {
            "Discord rejected the request body. Check lengths: content <= 2000 chars, embed title <= 256, embed description <= 4096, and that every ID is valid."
        }
        50036 => "The bot is not in the server that invite belongs to.",
        50045 => "The uploaded asset is too large.",
        50055 => "That server is unavailable right now.",
        50068 => "That message type cannot be deleted.",
        50083 => {
            "The thread is archived. Unarchive it first via discord_manage_thread with action unarchive."
        }
        50085 => "The requested message range is too large. Lower the limit.",
        50095 => "That server is under a raid-protection lockdown.",
        160002 => "That message already has an active thread.",
        160004 => "A thread cannot be created on this message.",
        160005 => "The thread is locked. Unlock it via discord_manage_thread with action unlock.",
        500000 => {
            "Bulk ban failed for every user. Check they are not already banned and sit below the bot's highest role."
        }
        _ => return None,
    })
}

fn status_hint(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "Discord rejected the request shape. Re-check argument types and length limits.",
        401 => {
            "The bot token is invalid or was reset. Generate a new one (Developer Portal -> Bot -> Reset Token) and update DISCORD_TOKEN."
        }
        403 => {
            "The bot is forbidden from doing this - usually a missing permission or a role-hierarchy problem."
        }
        404 => "That resource does not exist. Double-check the ID, or re-resolve it by name.",
        429 => "Rate limited by Discord. Lower concurrency on batch calls, or wait and retry.",
        500 => "Discord had an internal error. Retry in a moment.",
        502 => "Discord gateway trouble on their side. Retry in a moment.",
        503 => "Discord is temporarily unavailable. Retry in a moment.",
        504 => "Discord timed out. Retry in a moment.",
        _ => return None,
    })
}

/// Converts anything thrown inside a tool into a ToolError carrying an
/// agent-actionable hint. `context` names the attempted operation.
pub fn normalize_error(error: &Error, context: &str) -> ToolError {
    match error {
        Error::Tool(t) => t.clone(),
        Error::Api { status, code, message } => {
            let hint = code_hint(*code).or_else(|| status_hint(*status)).map(str::to_string);
            ToolError::new(format!("Could not {context}: {message} (Discord code {code})")).num(*code).maybe_hint(hint)
        }
        Error::RateLimit { seconds, route } => {
            ToolError::new(format!("Could not {context}: rate limited for {seconds}s on route {route}."))
                .num(429)
                .hint("Retry after the wait, and reduce concurrency if this came from a batch call.")
        }
        Error::Http { status, message } => ToolError::new(format!("Could not {context}: HTTP {status} {message}"))
            .num(i64::from(*status))
            .maybe_hint(status_hint(*status).map(str::to_string)),
        Error::Timeout => ToolError::new(format!("Could not {context}: the request was cancelled or timed out."))
            .code("TIMEOUT")
            .hint("If it was not cancelled, Discord may be slow: retry, or raise DISCORD_REQUEST_TIMEOUT_MS."),
        Error::Other(message) => ToolError::new(format!("Could not {context}: {message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_error_gets_code_hint() {
        let e = Error::Api {
            status: 403,
            code: 50013,
            message: "Missing Permissions".into(),
        };
        let t = normalize_error(&e, "send a message");
        assert_eq!(
            t.message,
            "Could not send a message: Missing Permissions (Discord code 50013)"
        );
        assert!(
            t.hint
                .unwrap()
                .starts_with("The bot is missing a permission.")
        );
        assert_eq!(t.code, Some(Code::Num(50013)));
    }

    #[test]
    fn unknown_code_falls_back_to_status() {
        let e = Error::Api {
            status: 404,
            code: 99999,
            message: "x".into(),
        };
        assert!(
            normalize_error(&e, "a")
                .hint
                .unwrap()
                .starts_with("That resource does not exist.")
        );
    }

    #[test]
    fn tool_error_text() {
        let t = ToolError::new("A").hint("B");
        assert_eq!(t.to_text(), "A\nHint: B");
        assert_eq!(ToolError::new("A").to_text(), "A");
    }

    #[test]
    fn timeout_and_http() {
        assert!(normalize_error(&Error::Timeout, "x").is("TIMEOUT"));
        let h = normalize_error(
            &Error::Http {
                status: 502,
                message: "Bad Gateway".into(),
            },
            "read",
        );
        assert_eq!(h.message, "Could not read: HTTP 502 Bad Gateway");
    }
}
