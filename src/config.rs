//! Runtime configuration, parsed once at startup from the environment.
//!
//! Everything except the token has a sane default, so the minimum viable
//! configuration is a single DISCORD_TOKEN entry. Error lines keep the wording
//! of the original server.

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Config {
    pub token: String,
    pub default_guild: Option<String>,
    pub allow_destructive: bool,
    /// Lets messages ping @everyone/@here (allow_mentions: 'everyone').
    pub allow_mass_mentions: bool,
    pub privileged_intents: bool,
    pub request_timeout_ms: u64,
    pub max_response_chars: usize,
    pub gateway_idle_ms: u64,
    pub event_buffer_size: usize,
    pub batch_concurrency: usize,
    /// Folders local file uploads may come from; None allows any path.
    pub upload_dirs: Option<Vec<String>>,
}

/// The environment is missing or malformed; the message is user-facing.
#[derive(Debug)]
pub struct ConfigError(pub String);

const BOOL_OPTIONS: &str = "\"0\"|\"1\"|\"true\"|\"false\"|\"yes\"|\"no\"";

pub fn load_config(env: &HashMap<String, String>) -> Result<Config, ConfigError> {
    // Blank variables count as unset: MCP client templates often emit KEY="" for options left empty.
    let get = |key: &str| {
        env.get(key)
            .filter(|v| !crate::js::trim(v).is_empty())
            .cloned()
    };
    let mut issues: Vec<String> = Vec::new();

    let token = match get("DISCORD_TOKEN") {
        None => {
            issues.push("DISCORD_TOKEN: DISCORD_TOKEN is missing or empty".into());
            String::new()
        }
        Some(raw) => {
            let t = crate::js::trim(&raw).to_string();
            if t.to_lowercase().starts_with("bot ") {
                issues.push(
                    "DISCORD_TOKEN: DISCORD_TOKEN must not include the 'Bot ' prefix - paste only the raw token".into(),
                );
            }
            t
        }
    };

    let default_guild = get("DISCORD_DEFAULT_GUILD").map(|g| crate::js::trim(&g).to_string());

    let mut boolean = |key: &str, fallback: bool| -> bool {
        match get(key) {
            None => fallback,
            Some(v) => match v.as_str() {
                "true" | "1" | "yes" => true,
                "false" | "0" | "no" => false,
                _ => {
                    issues.push(format!(
                        "{key}: Invalid option: expected one of {BOOL_OPTIONS}"
                    ));
                    fallback
                }
            },
        }
    };
    let allow_destructive = boolean("DISCORD_ALLOW_DESTRUCTIVE", false);
    let allow_mass_mentions = boolean("DISCORD_ALLOW_MASS_MENTIONS", false);
    let privileged_intents = boolean("DISCORD_PRIVILEGED_INTENTS", true);

    let mut int = |key: &str, min: i64, max: i64, fallback: i64| -> i64 {
        let Some(raw) = get(key) else { return fallback };
        let n = crate::js::number(&raw);
        if n.is_nan() {
            issues.push(format!(
                "{key}: Invalid input: expected number, received NaN"
            ));
        } else if n.is_infinite() {
            issues.push(format!(
                "{key}: Invalid input: expected number, received Infinity"
            ));
        } else if n.fract() != 0.0 {
            issues.push(format!(
                "{key}: Invalid input: expected int, received number"
            ));
        } else if n < min as f64 {
            issues.push(format!("{key}: Too small: expected number to be >={min}"));
        } else if n > max as f64 {
            issues.push(format!("{key}: Too big: expected number to be <={max}"));
        } else {
            return n as i64;
        }
        fallback
    };
    let request_timeout_ms = int("DISCORD_REQUEST_TIMEOUT_MS", 1_000, 120_000, 15_000);
    let max_response_chars = int("DISCORD_MAX_RESPONSE_CHARS", 2_000, 200_000, 25_000);
    let gateway_idle_ms = int("DISCORD_GATEWAY_IDLE_MS", 10_000, 3_600_000, 120_000);
    let event_buffer_size = int("DISCORD_EVENT_BUFFER", 20, 5_000, 200);
    let batch_concurrency = int("DISCORD_BATCH_CONCURRENCY", 1, 20, 4);

    if !issues.is_empty() {
        let details = issues
            .iter()
            .map(|i| format!("  - {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ConfigError(format!(
            "Invalid Discord MCP configuration:\n{details}\n\n\
             Set DISCORD_TOKEN to your bot token. Create one at\n\
             https://discord.com/developers/applications -> your app -> Bot -> Reset Token"
        )));
    }

    let upload_dirs =
        parse_upload_dirs(get("DISCORD_UPLOAD_DIRS").map(|d| crate::js::trim(&d).to_string()));

    // INFALLIBLE: every number was range-checked above, so the casts below cannot truncate.
    Ok(Config {
        token,
        default_guild,
        allow_destructive,
        allow_mass_mentions,
        privileged_intents,
        request_timeout_ms: request_timeout_ms as u64,
        max_response_chars: max_response_chars as usize,
        gateway_idle_ms: gateway_idle_ms as u64,
        event_buffer_size: event_buffer_size as usize,
        batch_concurrency: batch_concurrency as usize,
        upload_dirs,
    })
}

/// Local uploads default to the working directory. "*" lifts the restriction entirely.
fn parse_upload_dirs(raw: Option<String>) -> Option<Vec<String>> {
    if raw.as_deref() == Some("*") {
        return None;
    }
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    let dirs: Vec<String> = raw
        .unwrap_or_default()
        .split(delimiter)
        .map(|d| crate::js::trim(d).to_string())
        .filter(|d| !d.is_empty())
        .collect();
    if dirs.is_empty() {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into());
        Some(vec![cwd])
    } else {
        Some(dirs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn minimal_config() {
        let c = load_config(&env(&[("DISCORD_TOKEN", " abc ")])).unwrap();
        assert_eq!(c.token, "abc");
        assert!(!c.allow_destructive);
        assert!(c.privileged_intents);
        assert_eq!(c.request_timeout_ms, 15_000);
        assert_eq!(c.batch_concurrency, 4);
        assert!(c.upload_dirs.is_some());
    }

    #[test]
    fn blank_values_are_defaults() {
        let c = load_config(&env(&[
            ("DISCORD_TOKEN", "x"),
            ("DISCORD_ALLOW_DESTRUCTIVE", " "),
            ("DISCORD_UPLOAD_DIRS", "*"),
        ]))
        .unwrap();
        assert!(!c.allow_destructive);
        assert!(c.upload_dirs.is_none());
    }

    #[test]
    fn errors_in_schema_order() {
        let e = load_config(&env(&[
            ("DISCORD_TOKEN", "x"),
            ("DISCORD_REQUEST_TIMEOUT_MS", "5"),
            ("DISCORD_ALLOW_DESTRUCTIVE", "maybe"),
            ("DISCORD_EVENT_BUFFER", "abc"),
            ("DISCORD_BATCH_CONCURRENCY", "2.5"),
            ("DISCORD_MAX_RESPONSE_CHARS", "999999999"),
        ]))
        .unwrap_err()
        .0;
        let expected = [
            "Invalid Discord MCP configuration:",
            "  - DISCORD_ALLOW_DESTRUCTIVE: Invalid option: expected one of \"0\"|\"1\"|\"true\"|\"false\"|\"yes\"|\"no\"",
            "  - DISCORD_REQUEST_TIMEOUT_MS: Too small: expected number to be >=1000",
            "  - DISCORD_MAX_RESPONSE_CHARS: Too big: expected number to be <=200000",
            "  - DISCORD_EVENT_BUFFER: Invalid input: expected number, received NaN",
            "  - DISCORD_BATCH_CONCURRENCY: Invalid input: expected int, received number",
            "",
            "",
        ]
        .join("\n");
        assert!(e.starts_with(&expected), "{e}");
    }

    #[test]
    fn bot_prefix_and_missing_token() {
        let e = load_config(&env(&[("DISCORD_TOKEN", "Bot abc")]))
            .unwrap_err()
            .0;
        assert!(e.contains("must not include the 'Bot ' prefix"));
        let e = load_config(&env(&[])).unwrap_err().0;
        assert!(e.contains("DISCORD_TOKEN: DISCORD_TOKEN is missing or empty"));
    }
}
