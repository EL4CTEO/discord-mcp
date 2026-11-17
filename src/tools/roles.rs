//! Role tools: listing, create/edit/delete, and the role hierarchy.

use super::util::plural;
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::{Result, ToolError, destructive_disabled};
use crate::format::{Detail, format_role};
use crate::json::{arr, id, s};
use crate::obj;
use crate::permissions::{assert_may_grant, bit, bits_of, parse_bits};
use futures::future::BoxFuture;
use serde_json::{Value, json};

fn to_colour(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => i64::from_str_radix(s.trim_start_matches('#'), 16).ok(),
        _ => None,
    }
}

/// Discord deprecated the single `color` field in favour of a colours object;
/// a secondary colour makes the role a gradient.
fn to_colors(primary: Option<&Value>, secondary: Option<&Value>) -> Option<Value> {
    let primary = primary?;
    Some(
        obj! { "primary_color" => to_colour(primary), "secondary_color" => secondary.and_then(to_colour) },
    )
}

/// Role permissions given as names or a raw decimal bitfield, as a bitfield string.
fn role_permission_bits(input: Option<&Value>) -> Option<String> {
    match input? {
        Value::String(s) => Some(s.clone()),
        Value::Array(names) => Some(
            names
                .iter()
                .filter_map(Value::as_str)
                .filter_map(bit)
                .fold(0u128, |acc, b| acc | u128::from(b))
                .to_string(),
        ),
        _ => None,
    }
}

pub fn list_roles() -> ToolDef {
    ToolDef::new("discord_list_roles", list_roles_handler)
}

fn position(r: &Value) -> i64 {
    r.get("position").and_then(Value::as_i64).unwrap_or(0)
}

fn list_roles_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let roles = ctx.resolver.roles(&guild_id).await?;
        let mut sorted: Vec<Value> = roles.to_vec();
        sorted.sort_by_key(|r| std::cmp::Reverse(position(r)));
        let detail = a.detail();
        Ok(Outcome::with(
            format!(
                "{} in server {guild_id}, highest first.",
                plural(sorted.len(), "role")
            ),
            Value::Array(sorted.iter().map(|r| format_role(r, detail)).collect()),
        ))
    })
}

pub fn manage_role() -> ToolDef {
    ToolDef {
        bulk_args: &["name", "role"],
        missing_permission_hint: Some(
            "Needs Manage Roles, and the bot role must sit ABOVE the role being changed in Server Settings -> Roles. \
             A bot can only grant permissions it holds itself.",
        ),
        ..ToolDef::new("discord_manage_role", manage_role_handler)
    }
}

fn manage_role_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        if a.has("secondary_color") && !a.has("color") {
            return Err(ToolError::new(
                "`secondary_color` needs `color` as well, since it is the gradient's other end.",
            )
            .code("MISSING_ARG")
            .into());
        }

        let action = a.str("action").unwrap_or_default();
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let permissions = role_permission_bits(a.get("permissions"));
        let body = obj! {
            "name" => a.str("name"),
            "colors" => to_colors(a.get("color"), a.get("secondary_color")),
            "hoist" => a.opt_bool("hoist"),
            "mentionable" => a.opt_bool("mentionable"),
            "permissions" => permissions.clone(),
        };
        let reason = a.reason();
        let bits = |p: &Option<String>| p.as_deref().and_then(parse_bits).unwrap_or(0);

        if action == "create" {
            let Some(name) = a.str("name").filter(|n| !n.is_empty()) else {
                return Err(ToolError::new("`name` is required to create a role.")
                    .code("MISSING_ARG")
                    .into());
            };
            // A role carrying Administrator or Manage Roles is a route to taking over the server.
            assert_may_grant(
                bits(&permissions),
                ctx.config.allow_destructive,
                &format!("role \"{name}\""),
            )?;
            let role = ctx
                .rest
                .post(
                    &format!("/guilds/{guild_id}/roles"),
                    Some(body),
                    reason.as_deref(),
                    vec![],
                )
                .await?;
            ctx.resolver.upsert_role(&guild_id, &role);
            return Ok(Outcome::with(
                format!(
                    "Created role \"{}\" ({}).",
                    s(&role, "name").unwrap_or(""),
                    id(&role)
                ),
                format_role(&role, Detail::Full),
            ));
        }

        let Some(role_ref) = a.str("role").filter(|r| !r.is_empty()) else {
            return Err(
                ToolError::new(format!("`role` is required to {action} a role."))
                    .code("MISSING_ARG")
                    .hint("Call discord_list_roles to see available roles.")
                    .into(),
            );
        };

        // Only the delete branch is destructive; it is gated before any request.
        if action == "delete" && !ctx.config.allow_destructive {
            return Err(destructive_disabled("discord_manage_role delete"));
        }

        let role_id = ctx
            .resolver
            .role_id(&role_ref, &guild_id, action == "delete")
            .await?;

        // Editing can grant permissions too; only bits the role does not already hold count.
        if permissions.is_some() && !ctx.config.allow_destructive {
            // Read fresh: a stale copy holding more bits than the role now has would let new grants pass as old ones.
            let current = ctx
                .rest
                .get(&format!("/guilds/{guild_id}/roles/{role_id}"), &[], None)
                .await?;
            let held = current.get("permissions").and_then(bits_of).unwrap_or(0);
            assert_may_grant(
                bits(&permissions) & !held,
                false,
                &format!("role \"{role_ref}\""),
            )?;
        }

        if action == "delete" {
            ctx.rest
                .delete(
                    &format!("/guilds/{guild_id}/roles/{role_id}"),
                    reason.as_deref(),
                )
                .await?;
            ctx.resolver.remove_role(&guild_id, &role_id);
            return Ok(Outcome::text(format!(
                "Deleted role {role_ref} ({role_id})."
            )));
        }

        if body.as_object().is_none_or(serde_json::Map::is_empty) {
            return Err(ToolError::new(
                "Nothing to change: pass name, color, hoist, mentionable or permissions.",
            )
            .code("MISSING_ARG")
            .into());
        }

        let role = ctx
            .rest
            .patch(
                &format!("/guilds/{guild_id}/roles/{role_id}"),
                body,
                reason.as_deref(),
            )
            .await?;
        ctx.resolver.upsert_role(&guild_id, &role);
        Ok(Outcome::with(
            format!("Updated role \"{}\".", s(&role, "name").unwrap_or("")),
            format_role(&role, Detail::Full),
        ))
    })
}

pub fn reorder_roles() -> ToolDef {
    ToolDef {
        missing_permission_hint: Some(
            "Needs Manage Roles, and every role being moved must sit below the bot's own highest role.",
        ),
        ..ToolDef::new("discord_reorder_roles", reorder_roles_handler)
    }
}

fn reorder_roles_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let order = a.strs("order").unwrap_or_default();
        let (all_roles, ids, self_id) = tokio::try_join!(
            ctx.resolver.roles(&guild_id),
            futures::future::try_join_all(
                order
                    .iter()
                    .map(|r| ctx.resolver.role_id(r, &guild_id, false))
            ),
            ctx.resolver.self_id(),
        )?;

        let by_id = |rid: &str| all_roles.iter().find(|r| id(r) == rid);
        let name_of = |rid: &str| {
            by_id(rid)
                .and_then(|r| s(r, "name"))
                .unwrap_or(rid)
                .to_string()
        };

        if let Some(dup) = ids
            .iter()
            .enumerate()
            .find(|(i, x)| ids.iter().position(|y| y == *x) != Some(*i))
            .map(|(_, x)| x)
        {
            return Err(ToolError::new(format!(
                "\"{}\" appears more than once in order.",
                name_of(dup)
            ))
            .code("DUPLICATE_ROLE")
            .hint("List each role exactly once.")
            .into());
        }
        if ids.contains(&guild_id) {
            return Err(
                ToolError::new("@everyone is always the lowest role and cannot be moved.")
                    .code("INVALID_ARGS")
                    .into(),
            );
        }

        let me = ctx
            .rest
            .get(&format!("/guilds/{guild_id}/members/{self_id}"), &[], None)
            .await?;
        let bot_top = arr(&me, "roles")
            .iter()
            .filter_map(Value::as_str)
            .map(|rid| by_id(rid).map_or(0, position))
            .fold(0, i64::max);

        let ceiling = bot_top - 1;
        if ceiling < ids.len() as i64 {
            // A brand-new server leaves every role sharing position 1, where Discord breaks the tie by age.
            let tied = all_roles
                .iter()
                .filter(|r| position(r) == bot_top && id(r) != guild_id)
                .count();
            let (message, hint) = if tied > 1 {
                (
                    format!(
                        "All {tied} roles share position {bot_top}, including the bot's own, so there is no slot beneath it to order into."
                    ),
                    "Discord only assigns real positions once a role is moved by hand. Open Server Settings -> Roles, \
                     drag the bot's role to the top, and run this again.",
                )
            } else {
                (
                    format!(
                        "Not enough room below the bot to order {} roles (only {} slots).",
                        ids.len(),
                        ceiling.max(0)
                    ),
                    "Drag the bot's role higher in Server Settings -> Roles, then run this again.",
                )
            };
            return Err(ToolError::new(message).code("NO_ROOM").hint(hint).into());
        }

        let too_high: Vec<String> = ids
            .iter()
            .filter(|rid| by_id(rid).map_or(0, position) >= bot_top)
            .map(|rid| name_of(rid))
            .collect();
        if !too_high.is_empty() {
            return Err(ToolError::new(format!(
                "These roles sit at or above the bot's own role: {}.",
                too_high.join(", ")
            ))
            .code("ROLE_TOO_HIGH")
            .hint(
                "Drag the bot's role above them in Server Settings -> Roles, then run this again.",
            )
            .into());
        }

        // Every movable role below the bot, top-down: the listed ones first, then the rest in their current order.
        let mut rest: Vec<&Value> = all_roles
            .iter()
            .filter(|r| {
                id(r) != guild_id && position(r) < bot_top && !ids.iter().any(|i| i == id(r))
            })
            .collect();
        rest.sort_by(|x, y| {
            position(y).cmp(&position(x)).then_with(|| {
                if id(x) < id(y) {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                }
            })
        });
        let mut layout: Vec<String> = ids.clone();
        layout.extend(rest.iter().map(|r| id(r).to_string()));
        if layout.len() as i64 > ceiling {
            return Err(ToolError::new(format!(
                "Only {ceiling} positions sit below the bot, but {} roles need one.",
                layout.len()
            ))
            .code("NO_ROOM")
            .hint("Drag the roles apart once in Server Settings -> Roles, then run this again.")
            .into());
        }

        let positions: Vec<Value> = layout
            .iter()
            .enumerate()
            .map(|(index, rid)| (rid, (ceiling - index as i64).max(1)))
            .filter(|(rid, p)| by_id(rid).map(position) != Some(*p))
            .map(|(rid, p)| json!({ "id": rid, "position": p }))
            .collect();

        let updated: Vec<Value> = if positions.is_empty() {
            all_roles.to_vec()
        } else {
            let r = ctx
                .rest
                .patch(
                    &format!("/guilds/{guild_id}/roles"),
                    Value::Array(positions),
                    a.reason().as_deref(),
                )
                .await?;
            r.as_array().cloned().unwrap_or_default()
        };
        ctx.resolver.set_roles(&guild_id, updated.clone());

        let mut ranked = updated;
        ranked.sort_by_key(|r| std::cmp::Reverse(position(r)));
        Ok(Outcome::with(
            format!(
                "Reordered {}; highest is now \"{}\".",
                plural(ids.len(), "role"),
                order.first().cloned().unwrap_or_default()
            ),
            Value::Array(
                ranked
                    .iter()
                    .map(|r| json!({ "name": s(r, "name").unwrap_or(""), "position": position(r) }))
                    .collect(),
            ),
        ))
    })
}
