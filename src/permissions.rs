//! Discord permission names and bitfields, and the elevated-permission guard.

use crate::errors::{Result, ToolError};

/// Every permission Discord defines, in Discord's declaration order.
/// ManageEmojisAndStickers and ManageGuildExpressions are aliases for one bit.
pub const ALL: &[(&str, u64)] = &[
    ("CreateInstantInvite", 1 << 0),
    ("KickMembers", 1 << 1),
    ("BanMembers", 1 << 2),
    ("Administrator", 1 << 3),
    ("ManageChannels", 1 << 4),
    ("ManageGuild", 1 << 5),
    ("AddReactions", 1 << 6),
    ("ViewAuditLog", 1 << 7),
    ("PrioritySpeaker", 1 << 8),
    ("Stream", 1 << 9),
    ("ViewChannel", 1 << 10),
    ("SendMessages", 1 << 11),
    ("SendTTSMessages", 1 << 12),
    ("ManageMessages", 1 << 13),
    ("EmbedLinks", 1 << 14),
    ("AttachFiles", 1 << 15),
    ("ReadMessageHistory", 1 << 16),
    ("MentionEveryone", 1 << 17),
    ("UseExternalEmojis", 1 << 18),
    ("ViewGuildInsights", 1 << 19),
    ("Connect", 1 << 20),
    ("Speak", 1 << 21),
    ("MuteMembers", 1 << 22),
    ("DeafenMembers", 1 << 23),
    ("MoveMembers", 1 << 24),
    ("UseVAD", 1 << 25),
    ("ChangeNickname", 1 << 26),
    ("ManageNicknames", 1 << 27),
    ("ManageRoles", 1 << 28),
    ("ManageWebhooks", 1 << 29),
    ("ManageEmojisAndStickers", 1 << 30),
    ("ManageGuildExpressions", 1 << 30),
    ("UseApplicationCommands", 1 << 31),
    ("RequestToSpeak", 1 << 32),
    ("ManageEvents", 1 << 33),
    ("ManageThreads", 1 << 34),
    ("CreatePublicThreads", 1 << 35),
    ("CreatePrivateThreads", 1 << 36),
    ("UseExternalStickers", 1 << 37),
    ("SendMessagesInThreads", 1 << 38),
    ("UseEmbeddedActivities", 1 << 39),
    ("ModerateMembers", 1 << 40),
    ("ViewCreatorMonetizationAnalytics", 1 << 41),
    ("UseSoundboard", 1 << 42),
    ("CreateGuildExpressions", 1 << 43),
    ("CreateEvents", 1 << 44),
    ("UseExternalSounds", 1 << 45),
    ("SendVoiceMessages", 1 << 46),
    ("SetVoiceChannelStatus", 1 << 48),
    ("SendPolls", 1 << 49),
    ("UseExternalApps", 1 << 50),
    ("PinMessages", 1 << 51),
    ("BypassSlowmode", 1 << 52),
];

pub fn bit(name: &str) -> Option<u64> {
    ALL.iter().find(|(n, _)| *n == name).map(|(_, b)| *b)
}

pub const ADMINISTRATOR: u64 = 1 << 3;
pub const VIEW_CHANNEL: u64 = 1 << 10;

/// One name per bit, keeping the first bit's position but the last alias's name
/// (how a JS Map built from the declaration order behaves).
fn canonical() -> Vec<(&'static str, u64)> {
    let mut out: Vec<(&'static str, u64)> = Vec::new();
    for &(name, b) in ALL {
        match out.iter_mut().find(|(_, existing)| *existing == b) {
            Some(slot) => slot.0 = name,
            None => out.push((name, b)),
        }
    }
    out
}

/// Parses a decimal bitfield the way `BigInt(text)` does; None when it is not one.
pub fn parse_bits(text: &str) -> Option<u128> {
    let t = crate::js::trim(text);
    if t.is_empty() {
        return Some(0);
    }
    t.parse::<u128>().ok()
}

/// A bitfield's value from a JSON string or number.
pub fn bits_of(value: &serde_json::Value) -> Option<u128> {
    match value {
        serde_json::Value::String(s) => parse_bits(s),
        serde_json::Value::Number(n) => n.as_u64().map(u128::from),
        _ => None,
    }
}

/// Decodes a bitfield into permission names. Administrator implies everything,
/// so it is reported alone.
pub fn permission_names(bits: u128) -> Vec<String> {
    if bits & u128::from(ADMINISTRATOR) != 0 {
        return vec!["Administrator".into()];
    }
    canonical()
        .into_iter()
        .filter(|(_, b)| bits & u128::from(*b) != 0)
        .map(|(n, _)| n.to_string())
        .collect()
}

/// Combines permission names into a bitfield.
pub fn to_bits(names: &[String]) -> u128 {
    names
        .iter()
        .filter_map(|n| bit(n))
        .fold(0u128, |acc, b| acc | u128::from(b))
}

/// Permissions that hand over control of a server, or of its members.
fn elevated_mask() -> u128 {
    [
        "Administrator",
        "ManageGuild",
        "ManageRoles",
        "ManageChannels",
        "ManageWebhooks",
        "ManageMessages",
        "ManageThreads",
        "ManageNicknames",
        "ManageGuildExpressions",
        "ManageEvents",
        "BanMembers",
        "KickMembers",
        "ModerateMembers",
        "MuteMembers",
        "DeafenMembers",
        "MoveMembers",
        "MentionEveryone",
        "ViewAuditLog",
    ]
    .iter()
    .filter_map(|n| bit(n))
    .fold(0u128, |acc, b| acc | u128::from(b))
}

/// The elevated permissions contained in a bitfield, by name.
pub fn elevated_in(bits: u128) -> Vec<String> {
    let elevated = bits & elevated_mask();
    if elevated == 0 {
        Vec::new()
    } else {
        permission_names(elevated)
    }
}

/// Refuses a grant of elevated permissions unless destructive actions are enabled.
pub fn assert_may_grant(bits: u128, allow_destructive: bool, what: &str) -> Result<()> {
    if allow_destructive {
        return Ok(());
    }
    let elevated = elevated_in(bits);
    if elevated.is_empty() {
        return Ok(());
    }
    Err(ToolError::new(format!(
        "Refused: granting {} to {what} needs destructive actions enabled.",
        elevated.join(", ")
    ))
    .code("ELEVATED_PERMISSION")
    .hint(
        "Administrative and moderation permissions can be used to take over a server, so granting them is gated \
         like bans and deletes. The operator can set DISCORD_ALLOW_DESTRUCTIVE=true, or grant it by hand in \
         Server Settings -> Roles.",
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_use_canonical_alias() {
        assert_eq!(permission_names(1 << 30), vec!["ManageGuildExpressions"]);
        assert_eq!(permission_names(8 | 16), vec!["Administrator"]);
        assert_eq!(
            permission_names(1024 | 2048),
            vec!["ViewChannel", "SendMessages"]
        );
    }

    #[test]
    fn grant_guard() {
        assert!(assert_may_grant(1024, false, "x").is_ok());
        let e = assert_may_grant(8, false, "role \"A\"").unwrap_err();
        assert!(e.is("ELEVATED_PERMISSION"));
        assert!(assert_may_grant(8, true, "x").is_ok());
    }

    #[test]
    fn bitfields() {
        assert_eq!(
            to_bits(&["ViewChannel".into(), "SendMessages".into()]),
            3072
        );
        assert_eq!(parse_bits("2251799813685248"), Some(1 << 51));
        assert_eq!(parse_bits("x"), None);
    }
}
