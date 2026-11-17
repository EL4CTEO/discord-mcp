//! Member tools: list/search, details, edits and role assignment.

use super::util::plural;
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::{Error, Result, ToolError, error_text};
use crate::format::format_member;
use crate::json::{arr, id, s};
use crate::limiter::map_with_concurrency;
use crate::permissions::{assert_may_grant, bits_of};
use crate::rest::{q, qo};
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

pub fn list_members() -> ToolDef {
    ToolDef::new("discord_list_members", list_members_handler)
}

fn list_members_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let query = a.str("query");
        let limit = a.i64("limit").unwrap_or(100);
        let with_role = a.str("with_role");

        let (role_names, members, role_id) = tokio::try_join!(
            ctx.resolver.role_names(&guild_id),
            async {
                match &query {
                    Some(text) => {
                        ctx.rest
                            .get(
                                &format!("/guilds/{guild_id}/members/search"),
                                &[("query", q(text)), ("limit", q(limit))],
                                None,
                            )
                            .await
                    }
                    None => {
                        ctx.rest
                            .get(
                                &format!("/guilds/{guild_id}/members"),
                                &[("limit", q(limit)), ("after", qo(a.str("after")))],
                                None,
                            )
                            .await
                    }
                }
            },
            async {
                match &with_role {
                    Some(r) => ctx.resolver.role_id(r, &guild_id, false).await.map(Some),
                    None => Ok(None),
                }
            },
        )?;
        let members = members.as_array().cloned().unwrap_or_default();

        // @everyone resolves to the guild id, which no member lists in its roles, so it filters nothing.
        let filter_id = role_id.filter(|r| *r != guild_id);
        let filtered: Vec<&Value> = match &filter_id {
            None => members.iter().collect(),
            Some(rid) => members
                .iter()
                .filter(|m| {
                    arr(m, "roles")
                        .iter()
                        .any(|r| r.as_str() == Some(rid.as_str()))
                })
                .collect(),
        };
        let more = match members.last() {
            Some(last) if query.is_none() && members.len() as i64 == limit => {
                format!(
                    " More members exist: pass after={}.",
                    last.get("user").map_or("", id)
                )
            }
            _ => String::new(),
        };

        Ok(Outcome::with(
            format!(
                "{} in server {guild_id}{}.{more}",
                plural(filtered.len(), "member"),
                if filter_id.is_none() {
                    String::new()
                } else {
                    format!(" with that role (of {} fetched)", members.len())
                }
            ),
            Value::Array(
                filtered
                    .iter()
                    .map(|m| format_member(m, Some(&role_names)))
                    .collect(),
            ),
        ))
    })
}

pub fn get_member() -> ToolDef {
    ToolDef {
        bulk_args: &["member"],
        ..ToolDef::new("discord_get_member", get_member_handler)
    }
}

fn get_member_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let member_ref = a.str("member").unwrap_or_default();
        let ((uid, found), role_names) = tokio::try_join!(
            ctx.resolver.member(&member_ref, &guild_id, false),
            ctx.resolver.role_names(&guild_id)
        )?;
        // A name search already returned the full member; only an ID needs a fetch.
        let member = match found {
            Some(m) => m,
            None => {
                ctx.rest
                    .get(&format!("/guilds/{guild_id}/members/{uid}"), &[], None)
                    .await?
            }
        };
        let formatted = format_member(&member, Some(&role_names));
        let mut data = formatted.as_object().cloned().unwrap_or_default();
        if let Some(p) = member.get("premium_since").filter(|v| !v.is_null()) {
            data.insert("premium_since".into(), p.clone());
        }
        Ok(Outcome::with(
            format!(
                "{} (@{}) in server {guild_id}.",
                s(&formatted, "display_name").unwrap_or(""),
                s(&formatted, "username").unwrap_or("")
            ),
            Value::Object(data),
        ))
    })
}

pub fn edit_member() -> ToolDef {
    ToolDef {
        bulk_args: &["member"],
        missing_permission_hint: Some(
            "Needs Manage Nicknames (nickname), Mute/Deafen Members or Move Members (voice), and the bot's highest \
             role must sit above the member's.",
        ),
        ..ToolDef::new("discord_edit_member", edit_member_handler)
    }
}

fn edit_member_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        if !a.has("nickname") && !a.has("mute") && !a.has("deaf") && !a.has("move_to_voice_channel")
        {
            return Err(ToolError::new(
                "Nothing to change: pass nickname, mute, deaf or move_to_voice_channel.",
            )
            .code("MISSING_ARG")
            .into());
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let mv = a.get("move_to_voice_channel").cloned();
        let member_ref = a.str("member").unwrap_or_default();
        let (user_id, voice, self_id, role_names) = tokio::try_join!(
            ctx.resolver.member_id(&member_ref, &guild_id, false),
            async {
                // None: not moving; Some(Null): disconnect; Some(id): move.
                match &mv {
                    None => Ok(None),
                    Some(Value::Null) => Ok(Some(Value::Null)),
                    Some(v) => ctx
                        .resolver
                        .channel_id(v.as_str().unwrap_or(""), &guild_id, false)
                        .await
                        .map(|c| Some(Value::from(c))),
                }
            },
            ctx.resolver.self_id(),
            ctx.resolver.role_names(&guild_id),
        )?;

        // A bot renaming itself must use the @me route, which Discord gates on Change Nickname.
        let renaming_self =
            user_id == self_id && !a.has("mute") && !a.has("deaf") && voice.is_none();
        let nick = a.get("nickname").cloned();
        let reason = a.reason();

        let member = if renaming_self {
            let mut body = Map::new();
            if let Some(n) = nick {
                body.insert("nick".into(), n);
            }
            ctx.rest
                .patch(
                    &format!("/guilds/{guild_id}/members/@me"),
                    Value::Object(body),
                    reason.as_deref(),
                )
                .await?
        } else {
            let mut body = Map::new();
            if let Some(n) = nick {
                body.insert("nick".into(), n);
            }
            if let Some(m) = a.opt_bool("mute") {
                body.insert("mute".into(), m.into());
            }
            if let Some(d) = a.opt_bool("deaf") {
                body.insert("deaf".into(), d.into());
            }
            if let Some(v) = voice {
                body.insert("channel_id".into(), v);
            }
            ctx.rest
                .patch(
                    &format!("/guilds/{guild_id}/members/{user_id}"),
                    Value::Object(body),
                    reason.as_deref(),
                )
                .await?
        };

        Ok(Outcome::with(
            format!("Updated member {user_id}."),
            format_member(&member, Some(&role_names)),
        ))
    })
}

pub fn manage_member_roles() -> ToolDef {
    ToolDef {
        bulk_args: &["member"],
        missing_permission_hint: Some(
            "Needs Manage Roles, and the bot role must sit ABOVE both the target member and every role assigned.",
        ),
        ..ToolDef::new("discord_manage_member_roles", manage_member_roles_handler)
    }
}

struct RoleOp {
    role_id: String,
    label: String,
    add: bool,
}

fn manage_member_roles_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let add = a.strs("add").unwrap_or_default();
        let remove = a.strs("remove").unwrap_or_default();
        if add.is_empty() && remove.is_empty() {
            return Err(ToolError::new(
                "Nothing to do: pass at least one role in `add` or `remove`.",
            )
            .code("MISSING_ARG")
            .hint("Call discord_list_roles to see the roles available in this server.")
            .into());
        }

        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let member_ref = a.str("member").unwrap_or_default();
        // Taking a role away is a removal, so its targets must match exactly, like other removals.
        let removing = !remove.is_empty();
        let ((user_id, found), add_ids, remove_ids) = tokio::try_join!(
            ctx.resolver.member(&member_ref, &guild_id, removing),
            futures::future::try_join_all(
                add.iter()
                    .map(|r| ctx.resolver.role_id(r, &guild_id, false))
            ),
            futures::future::try_join_all(
                remove
                    .iter()
                    .map(|r| ctx.resolver.role_id(r, &guild_id, true))
            ),
        )?;

        if add_ids.iter().any(|i| remove_ids.contains(i)) {
            return Err(ToolError::new("The same role is in both add and remove.")
                .code("CONFLICTING_ARGS")
                .into());
        }

        // Granting a role with Administrator or Manage Roles is gated like a destructive action.
        if !ctx.config.allow_destructive && !add_ids.is_empty() {
            // Read fresh, not from cache: a role given Administrator a minute ago must not pass on its old permissions.
            let roles = ctx
                .rest
                .get(&format!("/guilds/{guild_id}/roles"), &[], None)
                .await?;
            let roles = roles.as_array().cloned().unwrap_or_default();
            for rid in &add_ids {
                let Some(role) = roles.iter().find(|r| id(r) == rid) else {
                    return Err(ToolError::new(format!(
                        "Role {rid} does not exist in this server."
                    ))
                    .code("NOT_FOUND")
                    .hint("Call discord_list_roles for valid roles.")
                    .into());
                };
                let bits = role.get("permissions").and_then(bits_of).unwrap_or(0);
                assert_may_grant(
                    bits,
                    false,
                    &format!(
                        "member {member_ref} via role \"{}\"",
                        s(role, "name").unwrap_or("")
                    ),
                )?;
            }
        }

        let mut operations: Vec<RoleOp> = Vec::new();
        for (i, rid) in add_ids.iter().enumerate() {
            operations.push(RoleOp {
                role_id: rid.clone(),
                label: format!("+{}", add.get(i).unwrap_or(rid)),
                add: true,
            });
        }
        for (i, rid) in remove_ids.iter().enumerate() {
            operations.push(RoleOp {
                role_id: rid.clone(),
                label: format!("-{}", remove.get(i).unwrap_or(rid)),
                add: false,
            });
        }
        let reason = a.reason();

        // Several changes collapse into a single PATCH of the full role list.
        if operations.len() > 1 {
            let attempt: Result<()> = async {
                let member = match &found {
                    Some(m) => m.clone(),
                    None => {
                        ctx.rest
                            .get(&format!("/guilds/{guild_id}/members/{user_id}"), &[], None)
                            .await?
                    }
                };
                let mut roles: Vec<String> = crate::json::strings(arr(&member, "roles"));
                for rid in &add_ids {
                    if !roles.contains(rid) {
                        roles.push(rid.clone());
                    }
                }
                roles.retain(|r| !remove_ids.contains(r));
                ctx.rest
                    .patch(
                        &format!("/guilds/{guild_id}/members/{user_id}"),
                        json!({ "roles": roles }),
                        reason.as_deref(),
                    )
                    .await?;
                Ok(())
            }
            .await;
            if attempt.is_ok() {
                return Ok(Outcome::with(
                    format!(
                        "Applied {} to member {user_id}.",
                        plural(operations.len(), "role change")
                    ),
                    json!({ "applied": operations.iter().map(|o| o.label.clone()).collect::<Vec<_>>() }),
                ));
            }
            // All-or-nothing failed; fall through to per-role calls so the report says which role was the problem.
        }

        let results = map_with_concurrency(
            operations
                .iter()
                .map(|o| (o.role_id.clone(), o.add))
                .collect(),
            ctx.config.batch_concurrency,
            |(rid, adding): (String, bool), _| {
                let ctx = ctx.clone();
                let route = format!("/guilds/{guild_id}/members/{user_id}/roles/{rid}");
                let reason = reason.clone();
                async move {
                    if adding {
                        ctx.rest.put(&route, None, reason.as_deref()).await
                    } else {
                        ctx.rest.delete(&route, reason.as_deref()).await
                    }
                }
            },
            false,
            Some(&ctx.cancel),
        )
        .await;

        let applied: Vec<String> = operations
            .iter()
            .zip(&results)
            .filter(|(_, r)| r.is_ok())
            .map(|(o, _)| o.label.clone())
            .collect();
        let failed: Vec<(String, Error)> = operations
            .iter()
            .zip(&results)
            .filter_map(|(o, r)| r.as_ref().err().map(|e| (o.label.clone(), e.clone())))
            .collect();

        // Nothing landed, so reporting success would mislead the agent.
        if applied.is_empty() && !failed.is_empty() {
            if operations.len() == 1 {
                return Err(failed[0].1.clone());
            }
            return Err(
                ToolError::new(format!("No role change applied to member {user_id}."))
                    .code("ROLE_CHANGE_FAILED")
                    .hint(
                        failed
                            .iter()
                            .map(|(role, e)| format!("{role}: {}", error_text(e)))
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
                    .into(),
            );
        }

        let mut data = Map::new();
        data.insert("applied".into(), applied.clone().into());
        if !failed.is_empty() {
            data.insert(
                "failed".into(),
                failed
                    .iter()
                    .map(|(role, e)| json!({ "role": role, "error": error_text(e) }))
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        Ok(Outcome::with(
            format!(
                "Applied {} to member {user_id}{}",
                plural(applied.len(), "role change"),
                if failed.is_empty() {
                    ".".to_string()
                } else {
                    format!("; {} failed.", failed.len())
                }
            ),
            Value::Object(data),
        ))
    })
}
