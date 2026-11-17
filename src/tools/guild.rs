//! Server-level tools: identity, server listing and details, invites.

use super::util::{plural, resolve_channel};
use super::{Args, Ctx, Outcome, ToolDef};
use crate::errors::Result;
use crate::format::{format_guild, snowflake_to_date};
use crate::json::{arr, id, s};
use crate::obj;
use crate::permissions::{bits_of, permission_names};
use crate::rest::q;
use futures::future::BoxFuture;
use serde_json::{Value, json};

/// Servers whose bot permissions whoami reports; beyond this it would be noise.
const WHOAMI_PERMISSION_GUILDS: usize = 5;

/// The bot's effective server-wide permissions and top role in one guild.
async fn bot_standing(ctx: &Ctx, guild_id: &str, self_id: &str) -> Result<Value> {
    let route = format!("/guilds/{guild_id}/members/{self_id}");
    let (member, roles) = tokio::try_join!(
        ctx.rest.get(&route, &[], None),
        ctx.resolver.roles(guild_id)
    )?;
    let mine: Vec<&str> = arr(&member, "roles")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let held: Vec<&Value> = roles
        .iter()
        .filter(|r| id(r) == guild_id || mine.contains(&id(r)))
        .collect();
    let bits = held
        .iter()
        .filter_map(|r| r.get("permissions").and_then(bits_of))
        .fold(0u128, |a, b| a | b);
    let position = |r: &Value| r.get("position").and_then(Value::as_i64).unwrap_or(0);
    let top = held
        .iter()
        .copied()
        .reduce(|a, b| if position(b) > position(a) { b } else { a });
    let (name, pos) = top.map_or(("@everyone".to_string(), 0), |t| {
        (s(t, "name").unwrap_or("").to_string(), position(t))
    });
    Ok(
        json!({ "top_role": format!("{name} (position {pos})"), "permissions": permission_names(bits) }),
    )
}

pub fn list_guilds() -> ToolDef {
    ToolDef::new("discord_list_guilds", list_guilds_handler)
}

fn list_guilds_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guilds = ctx.resolver.guilds().await?;
        if guilds.is_empty() {
            return Ok(Outcome::with(
                "The bot is not in any server yet. Invite it using the OAuth2 URL from the Developer Portal \
                 (scopes: bot, applications.commands).",
                json!([]),
            ));
        }
        let detail = a.detail();
        Ok(Outcome::with(
            format!("The bot is in {}.", plural(guilds.len(), "server")),
            Value::Array(guilds.iter().map(|g| format_guild(g, detail)).collect()),
        ))
    })
}

pub fn get_guild() -> ToolDef {
    ToolDef {
        bulk_args: &["guild"],
        ..ToolDef::new("discord_get_guild", get_guild_handler)
    }
}

fn get_guild_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let guild_id = ctx.resolver.guild_id(a.str("guild").as_deref()).await?;
        let route = format!("/guilds/{guild_id}");
        let query = [("with_counts", q(true))];
        let (guild, channels, roles) = tokio::try_join!(
            ctx.rest.get(&route, &query, None),
            ctx.resolver.channels(&guild_id),
            ctx.resolver.roles(&guild_id),
        )?;

        let formatted = format_guild(&guild, a.detail());
        let members = formatted
            .get("member_count")
            .map_or_else(|| "unknown".to_string(), ToString::to_string);
        let summary = format!(
            "{} - {members} members, {} channels, {} roles.",
            s(&guild, "name").unwrap_or(""),
            channels.len(),
            roles.len()
        );
        let mut data = formatted.as_object().cloned().unwrap_or_default();
        crate::json::put(&mut data, "created_at", snowflake_to_date(id(&guild)));
        data.insert("channel_count".into(), channels.len().into());
        data.insert("role_count".into(), roles.len().into());
        crate::json::put(
            &mut data,
            "online_count",
            guild.get("approximate_presence_count").cloned(),
        );
        Ok(Outcome::with(summary, Value::Object(data)))
    })
}

pub fn create_invite() -> ToolDef {
    ToolDef {
        bulk_args: &["channel"],
        missing_permission_hint: Some("Needs the Create Invite permission on that channel."),
        ..ToolDef::new("discord_create_invite", create_invite_handler)
    }
}

fn create_invite_handler(a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let channel_id = resolve_channel(
            &ctx,
            &a.str("channel").unwrap_or_default(),
            a.str("guild").as_deref(),
            false,
        )
        .await?;
        let max_uses = a.i64("max_uses").unwrap_or(0);
        let invite = ctx
            .rest
            .post(
                &format!("/channels/{channel_id}/invites"),
                Some(json!({
                    "max_age": a.i64("max_age_seconds").unwrap_or(86400),
                    "max_uses": max_uses,
                    "temporary": a.bool("temporary"),
                    "unique": true,
                })),
                a.reason().as_deref(),
                vec![],
            )
            .await?;

        let code = s(&invite, "code").unwrap_or("");
        let url = format!("https://discord.gg/{code}");
        Ok(Outcome::with(
            format!("Created invite {url} for channel {channel_id}."),
            obj! {
                "url" => url.clone(),
                "code" => code,
                "expires_at" => invite.get("expires_at").filter(|v| !v.is_null()).cloned(),
                "max_uses" => if max_uses == 0 { Value::from("unlimited") } else { Value::from(max_uses) },
            },
        ))
    })
}

pub fn who_am_i() -> ToolDef {
    ToolDef::new("discord_whoami", who_am_i_handler)
}

fn who_am_i_handler(_a: Args, ctx: Ctx) -> BoxFuture<'static, Result<Outcome>> {
    Box::pin(async move {
        let (me, guilds) = tokio::try_join!(ctx.resolver.self_user(), ctx.resolver.guilds())?;
        let me_id = id(&me).to_string();
        let standing =
            futures::future::join_all(guilds.iter().take(WHOAMI_PERMISSION_GUILDS).map(|g| {
                let ctx = ctx.clone();
                let gid = id(g).to_string();
                let me_id = me_id.clone();
                async move { bot_standing(&ctx, &gid, &me_id).await.ok() }
            }))
            .await;

        let servers: Vec<Value> = guilds
            .iter()
            .enumerate()
            .map(|(i, g)| {
                let base = json!({ "id": id(g), "name": s(g, "name").unwrap_or("") });
                match standing.get(i).cloned().flatten() {
                    Some(st) => crate::json::spread(&base, &st),
                    None => base,
                }
            })
            .collect();

        let username = s(&me, "username").unwrap_or("").to_string();
        let config = &ctx.config;
        Ok(Outcome::with(
            format!(
                "Connected as {username} ({me_id}), in {}.",
                plural(guilds.len(), "server")
            ),
            json!({
                "bot_username": username,
                "bot_id": me_id,
                "servers": servers,
                "destructive_actions_enabled": config.allow_destructive,
                "mass_mentions_enabled": config.allow_mass_mentions,
                "upload_dirs": config.upload_dirs.as_ref().map_or_else(|| Value::from("anywhere"), |d| Value::from(d.clone())),
                "privileged_intents": config.privileged_intents,
                "default_guild": config.default_guild.clone().map_or(Value::Null, Value::from),
                "gateway_connected": ctx.gateway.is_connected(),
            }),
        ))
    })
}
