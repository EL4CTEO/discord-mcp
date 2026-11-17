//! Registry and tool tests against a fake Discord, ported from the original
//! vitest suite: every REST call is recorded, and routes answer from a table.

use super::*;
use crate::errors::Error;
use crate::rest::{Method, Request, Transport};
use crate::server::DiscordServer;
use serde_json::json;
use std::collections::HashMap as Map2;

const GUILD: &str = "100000000000000001";
const GENERAL: &str = "200000000000000001";
const RANDOM: &str = "200000000000000002";
const CATEGORY: &str = "200000000000000003";
const VOICE: &str = "200000000000000004";
const BOT: &str = "300000000000000001";
const ALICE: &str = "300000000000000002";
const MOD_ROLE: &str = "400000000000000001";
const ADMIN_ROLE: &str = "400000000000000002";
const BOT_ROLE: &str = "400000000000000003";

type Answer = Arc<dyn Fn(&Request) -> Result<Value> + Send + Sync>;

#[derive(Default)]
struct Fake {
    routes: Mutex<Vec<(Method, String, Answer)>>,
    calls: Mutex<Vec<Request>>,
}

impl Fake {
    fn on(&self, method: Method, route: &str, value: Value) {
        self.routes.lock().unwrap().insert(
            0,
            (
                method,
                route.to_string(),
                Arc::new(move |_| Ok(value.clone())),
            ),
        );
    }

    fn fail(&self, method: Method, route: &str, error: Error) {
        self.routes.lock().unwrap().insert(
            0,
            (
                method,
                route.to_string(),
                Arc::new(move |_| Err(error.clone())),
            ),
        );
    }

    fn with(
        &self,
        method: Method,
        route: &str,
        answer: impl Fn(&Request) -> Result<Value> + Send + Sync + 'static,
    ) {
        self.routes
            .lock()
            .unwrap()
            .insert(0, (method, route.to_string(), Arc::new(answer)));
    }

    fn calls(&self) -> Vec<Request> {
        self.calls.lock().unwrap().clone()
    }

    fn writes(&self) -> Vec<Request> {
        self.calls()
            .into_iter()
            .filter(|c| c.method != Method::Get)
            .collect()
    }
}

struct FakeTransport(Arc<Fake>);

impl Transport for FakeTransport {
    fn send(&self, request: Request) -> BoxFuture<'static, Result<Value>> {
        let fake = Arc::clone(&self.0);
        Box::pin(async move {
            fake.calls.lock().unwrap().push(request.clone());
            let found = fake
                .routes
                .lock()
                .unwrap()
                .iter()
                .find(|(m, r, _)| *m == request.method && request.route.ends_with(r.as_str()))
                .map(|(_, _, a)| Arc::clone(a));
            match found {
                Some(answer) => answer(&request),
                None if request.method == Method::Get => {
                    Err(Error::Other(format!("unexpected route {}", request.route)))
                }
                None => Ok(Value::Null),
            }
        })
    }
}

fn api(status: u16, code: i64, message: &str) -> Error {
    Error::Api {
        status,
        code,
        message: message.into(),
    }
}

fn config(destructive: bool) -> Arc<Config> {
    let mut env: Map2<String, String> =
        [("DISCORD_TOKEN".to_string(), "test-token".to_string())].into();
    env.insert("DISCORD_UPLOAD_DIRS".into(), "*".into());
    if destructive {
        env.insert("DISCORD_ALLOW_DESTRUCTIVE".into(), "true".into());
    }
    Arc::new(crate::config::load_config(&env).unwrap())
}

/// A fake server with one guild, a few channels, roles and the bot user.
fn world(destructive: bool) -> (DiscordServer, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    fake.on(
        Method::Get,
        "/users/@me",
        json!({ "id": BOT, "username": "assistant", "bot": true }),
    );
    fake.on(
        Method::Get,
        "/users/@me/guilds",
        json!([{ "id": GUILD, "name": "TestPlace", "approximate_member_count": 3 }]),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/channels"),
        json!([
            { "id": GENERAL, "name": "general", "type": 0, "position": 0, "parent_id": null },
            { "id": RANDOM, "name": "random", "type": 0, "position": 1, "parent_id": CATEGORY },
            { "id": CATEGORY, "name": "Staff", "type": 4, "position": 0 },
            { "id": VOICE, "name": "General", "type": 2, "position": 2, "parent_id": null }
        ]),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/threads/active"),
        json!({ "threads": [] }),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/roles"),
        json!([
            { "id": GUILD, "name": "@everyone", "position": 0, "permissions": "1024" },
            { "id": MOD_ROLE, "name": "Moderator", "position": 1, "permissions": "8192" },
            { "id": ADMIN_ROLE, "name": "Admin", "position": 2, "permissions": "8" },
            { "id": BOT_ROLE, "name": "Assistant", "position": 5, "permissions": "268435456" }
        ]),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/{BOT}"),
        json!({ "user": { "id": BOT, "username": "assistant" }, "roles": [BOT_ROLE] }),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/search"),
        json!([{ "user": { "id": ALICE, "username": "alice", "global_name": "Alice" }, "nick": null, "roles": [MOD_ROLE] }]),
    );
    let server = DiscordServer::with_rest(
        config(destructive),
        Rest::new(Arc::new(FakeTransport(Arc::clone(&fake)))),
    );
    (server, fake)
}

async fn run(server: &DiscordServer, name: &str, args: Value) -> Result<Outcome> {
    server.registry.run(name, args, RunOptions::default()).await
}

fn message_text(e: &Error) -> String {
    crate::errors::error_text(e)
}

// --- Registry --------------------------------------------------------------

#[tokio::test]
async fn lists_available_tools_when_an_unknown_one_is_called() {
    let (server, _) = world(false);
    let e = run(&server, "discord_nope", json!({})).await.unwrap_err();
    let t = e.tool().unwrap();
    assert_eq!(t.message, "Unknown tool \"discord_nope\".");
    let hint = t.hint.clone().unwrap();
    assert!(hint.contains("discord_send_message"));
    assert!(
        !hint.contains("discord_delete_channel"),
        "hidden destructive tools stay out of the hint"
    );
}

#[tokio::test]
async fn destructive_tools_are_gated_and_hidden() {
    let (server, fake) = world(false);
    let e = run(
        &server,
        "discord_delete_channel",
        json!({ "channel": "general" }),
    )
    .await
    .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
    assert!(fake.calls().is_empty());
    assert_eq!(server.advertised().len(), 35);
    let (server, _) = world(true);
    assert_eq!(server.advertised().len(), 38);
}

#[tokio::test]
async fn reports_invalid_arguments_with_field_names() {
    let (server, _) = world(false);
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": "general", "bogus": 1 }),
    )
    .await
    .unwrap_err();
    let t = e.tool().unwrap();
    assert!(
        t.message
            .starts_with("Invalid arguments for discord_send_message: "),
        "{}",
        t.message
    );
    assert!(
        t.hint
            .as_ref()
            .unwrap()
            .starts_with("Expected fields: channel, guild, content")
    );
    let e = run(
        &server,
        "discord_read_messages",
        json!({ "channel": "general", "limit": 900 }),
    )
    .await
    .unwrap_err();
    assert!(e.is("INVALID_ARGS"));
    let e = run(&server, "discord_read_messages", json!({ "channel": [] }))
        .await
        .unwrap_err();
    assert!(e.is("INVALID_ARGS"), "an empty bulk array is rejected");
}

#[tokio::test]
async fn normalises_discord_errors_with_tool_hints() {
    let (server, fake) = world(false);
    fake.fail(Method::Put, "/@me", api(403, 50013, "Missing Permissions"));
    let e = run(
        &server,
        "discord_react",
        json!({ "channel": GENERAL, "message_id": "500000000000000001", "emoji": "✅" }),
    )
    .await
    .unwrap_err();
    let t = e.tool().unwrap();
    assert_eq!(
        t.message,
        "Could not add, remove or list reactions: Missing Permissions (Discord code 50013)"
    );
    assert!(
        t.hint
            .as_ref()
            .unwrap()
            .starts_with("Reacting needs Add Reactions")
    );

    fake.fail(
        Method::Post,
        "/messages",
        api(403, 50013, "Missing Permissions"),
    );
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "content": "hi" }),
    )
    .await
    .unwrap_err();
    assert!(
        e.tool()
            .unwrap()
            .hint
            .as_ref()
            .unwrap()
            .starts_with("The bot is missing a permission."),
        "generic advice without a tool hint"
    );
}

#[tokio::test]
async fn render_wraps_arrays_and_flags_all_failed() {
    let (text, structured, is_error) =
        render_outcome(&Outcome::with("Two.", json!([1, 2])), 25_000);
    assert_eq!(text, "Two.\n[1,2]");
    assert_eq!(structured.unwrap(), json!({ "result": [1, 2] }));
    assert!(!is_error);
    let (text, structured, is_error) = render_outcome(&Outcome::text("Only."), 25_000);
    assert_eq!(
        (text.as_str(), structured, is_error),
        ("Only.", None, false)
    );
    let failed = Outcome {
        summary: "x".into(),
        data: Some(json!([])),
        failed: Some(Failed::All),
    };
    assert!(render_outcome(&failed, 25_000).2);
}

// --- Bulk ------------------------------------------------------------------

#[tokio::test]
async fn fans_an_array_out_with_per_item_results_in_order() {
    let (server, fake) = world(false);
    fake.with(Method::Post, "/messages", |r| {
        if r.route.contains(RANDOM) { Err(api(403, 50001, "Missing Access")) } else { Ok(json!({ "id": "500000000000000009", "author": { "id": BOT, "username": "assistant" }, "content": "hi", "timestamp": "t", "attachments": [], "embeds": [] })) }
    });
    let out = run(
        &server,
        "discord_send_message",
        json!({ "channel": [GENERAL, RANDOM], "content": "hi" }),
    )
    .await
    .unwrap();
    assert_eq!(
        out.summary,
        "discord_send_message on 2 items: 1 succeeded, 1 failed."
    );
    assert_eq!(out.failed, Some(Failed::Some));
    let rows = out.data.unwrap();
    assert_eq!(rows[0]["channel"], GENERAL);
    assert_eq!(rows[0]["ok"], true);
    assert_eq!(rows[1]["ok"], false);
    assert!(
        rows[1]["error"]
            .as_str()
            .unwrap()
            .contains("Missing Access")
    );
}

#[tokio::test]
async fn refuses_two_arrays_at_once() {
    let (server, _) = world(false);
    let e = run(&server, "discord_react", json!({ "channel": GENERAL, "message_id": ["500000000000000001", "500000000000000002"], "emoji": ["✅", "❌"] }))
        .await
        .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "Only one of emoji, message_id may be an array in a single call."
    );
}

#[tokio::test]
async fn deletes_recent_messages_in_bulk_and_old_ones_individually() {
    let (server, fake) = world(true);
    let recent: Vec<String> = (0..3).map(|i| aged(60_000 + i)).collect();
    let old = aged(20 * 24 * 3_600_000);
    let mut ids = recent.clone();
    ids.push(old.clone());
    let out = run(
        &server,
        "discord_delete_message",
        json!({ "channel": GENERAL, "message_id": ids }),
    )
    .await
    .unwrap();
    assert_eq!(
        out.summary,
        "discord_delete_message on 4 items: 4 succeeded."
    );
    let writes = fake.writes();
    assert!(writes.iter().any(|w| {
        w.route.ends_with("/bulk-delete")
            && w.body.as_ref().unwrap()["messages"]
                .as_array()
                .unwrap()
                .len()
                == 3
    }));
    assert!(
        writes
            .iter()
            .any(|w| w.method == Method::Delete && w.route.ends_with(&old))
    );
}

#[tokio::test]
async fn bulk_delete_retries_per_id_only_for_id_specific_refusals() {
    let (server, fake) = world(true);
    let ids: Vec<String> = (0..2).map(|i| aged(60_000 + i)).collect();
    fake.fail(
        Method::Post,
        "/bulk-delete",
        api(403, 50013, "Missing Permissions"),
    );
    let out = run(
        &server,
        "discord_delete_message",
        json!({ "channel": GENERAL, "message_id": ids }),
    )
    .await
    .unwrap();
    assert_eq!(out.failed, Some(Failed::All));
    assert!(
        !fake.writes().iter().any(|w| w.method == Method::Delete),
        "a permission refusal is not retried id by id"
    );

    let (server, fake) = world(true);
    fake.fail(Method::Post, "/bulk-delete", api(400, 50034, "too old"));
    run(
        &server,
        "discord_delete_message",
        json!({ "channel": GENERAL, "message_id": ids }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()
            .iter()
            .filter(|w| w.method == Method::Delete)
            .count(),
        2
    );
}

/// Snowflake for a message created `age_ms` ago.
fn aged(age_ms: i64) -> String {
    (((crate::js::now_ms() - age_ms) as u128 - 1_420_070_400_000) << 22).to_string()
}

// --- Batch -----------------------------------------------------------------

#[tokio::test]
async fn batch_runs_operations_and_keeps_successes() {
    let (server, fake) = world(false);
    fake.fail(
        Method::Patch,
        &format!("/guilds/{GUILD}/roles/{MOD_ROLE}"),
        api(403, 50013, "Missing Permissions"),
    );
    let out = run(
        &server,
        "discord_batch",
        json!({ "operations": [
            { "tool": "discord_list_roles", "args": {} },
            { "tool": "discord_manage_role", "args": { "action": "edit", "role": "Moderator", "hoist": true } },
            { "tool": "discord_delete_channel", "args": { "channel": "general" } }
        ] }),
    )
    .await
    .unwrap();
    assert_eq!(out.summary, "Batch finished: 1/3 succeeded, 2 failures.");
    let rows = out.data.unwrap();
    assert_eq!(rows[0]["ok"], true);
    assert!(
        rows[1]["error"]
            .as_str()
            .unwrap()
            .contains("Needs Manage Roles")
    );
    assert!(
        rows[2]["error"]
            .as_str()
            .unwrap()
            .starts_with("Refused: \"discord_delete_channel\""),
        "nested ops take the destructive gate"
    );
    assert_eq!(rows[2]["tool"], "discord_delete_channel");
}

#[tokio::test]
async fn batch_refuses_nesting_and_oversized_fan_outs() {
    let (server, _) = world(false);
    let e = run(
        &server,
        "discord_batch",
        json!({ "operations": [{ "tool": "discord_batch", "args": {} }] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("NESTED_BATCH"));
    let channels: Vec<String> = (0..50).map(|i| format!("c{i}")).collect();
    let ops: Vec<Value> = (0..3)
        .map(|_| json!({ "tool": "discord_read_messages", "args": { "channel": channels } }))
        .collect();
    let e = run(&server, "discord_batch", json!({ "operations": ops }))
        .await
        .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "This batch would make 150 Discord calls; the limit is 100."
    );
}

#[tokio::test]
async fn batch_defaults_only_fill_accepted_keys() {
    let (server, fake) = world(false);
    run(&server, "discord_batch", json!({ "operations": [{ "tool": "discord_list_roles", "args": {} }], "defaults": { "guild": GUILD, "content": "x" } }))
        .await
        .unwrap();
    assert!(
        fake.calls()
            .iter()
            .any(|c| c.route == format!("/guilds/{GUILD}/roles"))
    );
}

#[tokio::test]
async fn batch_reports_an_all_failed_fan_out_with_item_errors() {
    let (server, fake) = world(false);
    fake.fail(Method::Post, "/messages", api(403, 50001, "Missing Access"));
    let out = run(
        &server,
        "discord_batch",
        json!({ "operations": [{ "tool": "discord_send_message", "args": { "channel": [GENERAL, RANDOM], "content": "x" } }] }),
    )
    .await
    .unwrap();
    let err = out.data.unwrap()[0]["error"].as_str().unwrap().to_string();
    assert!(err.starts_with("discord_send_message on 2 items: 0 succeeded, 2 failed.\nHint: Failed items: 200000000000000001: "), "{err}");
}

// --- Messages --------------------------------------------------------------

fn sent(id: &str) -> Value {
    json!({ "id": id, "author": { "id": BOT, "username": "assistant" }, "content": "", "timestamp": "t", "attachments": [], "embeds": [], "type": 0 })
}

#[tokio::test]
async fn splits_long_text_replying_only_with_the_first_part() {
    let (server, fake) = world(false);
    let n = Arc::new(Mutex::new(0));
    fake.with(Method::Post, "/messages", move |_| {
        let mut k = n.lock().unwrap();
        *k += 1;
        Ok(sent(&format!("50000000000000000{k}")))
    });
    let text = format!("{}\n\n{}", "a".repeat(1500), "b".repeat(1500));
    let out = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "content": text, "reply_to": "500000000000000099" }),
    )
    .await
    .unwrap();
    assert!(
        out.summary
            .starts_with("Sent 2 messages to channel 200000000000000001 (text was split)")
    );
    let posts = fake.writes();
    assert_eq!(posts.len(), 2);
    assert!(
        posts[0]
            .body
            .as_ref()
            .unwrap()
            .get("message_reference")
            .is_some()
    );
    assert!(
        posts[1]
            .body
            .as_ref()
            .unwrap()
            .get("message_reference")
            .is_none()
    );
    assert_eq!(
        posts[0].body.as_ref().unwrap()["allowed_mentions"],
        json!({ "parse": [], "replied_user": false })
    );
}

#[tokio::test]
async fn partial_sends_report_the_ids_already_sent() {
    let (server, fake) = world(false);
    let n = Arc::new(Mutex::new(0));
    fake.with(Method::Post, "/messages", move |_| {
        let mut k = n.lock().unwrap();
        *k += 1;
        if *k == 2 {
            Err(api(500, 0, "boom"))
        } else {
            Ok(sent("500000000000000001"))
        }
    });
    let text = format!("{}\n\n{}", "a".repeat(1500), "b".repeat(1500));
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "content": text }),
    )
    .await
    .unwrap_err();
    let t = e.tool().unwrap();
    assert!(
        t.message.starts_with(
            "Sent 1 of 2 parts, then failed: boom. Sent message ids: 500000000000000001."
        ),
        "{}",
        t.message
    );
    assert!(t.is("PARTIAL_SEND"));
}

#[tokio::test]
async fn refuses_empty_messages_and_conflicting_options_locally() {
    let (server, fake) = world(false);
    assert!(
        run(
            &server,
            "discord_send_message",
            json!({ "channel": GENERAL })
        )
        .await
        .unwrap_err()
        .is("EMPTY_MESSAGE")
    );
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "embeds": [{ "title": "x" }], "suppress_embeds": true }),
    )
    .await
    .unwrap_err();
    assert!(e.is("CONFLICTING_ARGS"));
    let e = run(&server, "discord_send_message", json!({ "channel": GENERAL, "content": "x", "forward": { "channel": RANDOM, "message_id": "500000000000000001" } }))
        .await
        .unwrap_err();
    assert!(e.is("CONFLICTING_ARGS"));
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "content": "@everyone", "allow_mentions": "everyone" }),
    )
    .await
    .unwrap_err();
    assert!(e.is("MASS_MENTION_DISABLED"));
    assert!(fake.writes().is_empty());
}

#[tokio::test]
async fn embed_total_is_checked_up_front() {
    let (server, _) = world(false);
    let big = json!([{ "description": "x".repeat(4000) }, { "description": "y".repeat(2001) }]);
    let e = run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "embeds": big }),
    )
    .await
    .unwrap_err();
    assert!(
        e.tool()
            .unwrap()
            .message
            .contains("embeds: Embeds total 6001 characters"),
        "{}",
        message_text(&e)
    );
    let ok = json!([{ "description": "x".repeat(4000) }, { "description": "y".repeat(2000), "color": "#5865F2" }]);
    let (server, fake) = world(false);
    fake.on(Method::Post, "/messages", sent("500000000000000001"));
    run(
        &server,
        "discord_send_message",
        json!({ "channel": GENERAL, "embeds": ok }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].body.as_ref().unwrap()["embeds"][1]["color"],
        5_793_266
    );
}

#[tokio::test]
async fn forwards_send_only_a_reference() {
    let (server, fake) = world(false);
    fake.on(Method::Post, "/messages", sent("500000000000000002"));
    let out = run(&server, "discord_send_message", json!({ "channel": "general", "forward": { "channel": "random", "message_id": "500000000000000001" } }))
        .await
        .unwrap();
    assert!(out.summary.starts_with("Forwarded message 500000000000000001 from channel 200000000000000002 to channel 200000000000000001"));
    assert_eq!(
        fake.writes()[0].body.clone().unwrap(),
        json!({ "message_reference": { "type": 1, "message_id": "500000000000000001", "channel_id": RANDOM } })
    );
}

#[tokio::test]
async fn read_messages_rejects_large_limit_with_around() {
    let (server, _) = world(false);
    let e = run(
        &server,
        "discord_read_messages",
        json!({ "channel": GENERAL, "around": "500000000000000001", "limit": 200 }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "limit is 200, which cannot be combined with around."
    );
}

#[tokio::test]
async fn ends_a_poll_through_the_expire_route() {
    let (server, fake) = world(false);
    fake.on(Method::Post, "/expire", sent("500000000000000001"));
    run(
        &server,
        "discord_manage_poll",
        json!({ "channel": GENERAL, "message_id": "500000000000000001", "action": "end" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].route,
        format!("/channels/{GENERAL}/polls/500000000000000001/expire")
    );
}

// --- Channels --------------------------------------------------------------

#[tokio::test]
async fn lists_channels_in_display_order_with_categories() {
    let (server, _) = world(false);
    let out = run(&server, "discord_list_channels", json!({}))
        .await
        .unwrap();
    let names: Vec<&str> = out
        .data
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["general", "General", "Staff", "random"]);
    assert_eq!(out.data.unwrap()[3]["category"], "Staff");
}

#[tokio::test]
async fn literal_name_picks_the_text_channel_over_the_voice_one() {
    let (server, fake) = world(false);
    fake.on(Method::Post, "/messages", sent("500000000000000001"));
    run(
        &server,
        "discord_send_message",
        json!({ "channel": "general", "content": "hi" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].route,
        format!("/channels/{GENERAL}/messages")
    );
}

#[tokio::test]
async fn set_permissions_merge_keeps_unnamed_bits() {
    let (server, fake) = world(false);
    fake.on(
        Method::Get,
        &format!("/channels/{GENERAL}"),
        json!({ "id": GENERAL, "type": 0, "guild_id": GUILD, "permission_overwrites": [
        { "id": GUILD, "type": 0, "allow": (1u64 << 40 | 2048).to_string(), "deny": "0" }
    ] }),
    );
    let out = run(
        &server,
        "discord_set_channel_permissions",
        json!({ "channel": GENERAL, "target": "@everyone", "deny": ["SendMessages"] }),
    )
    .await
    .unwrap();
    let put = fake
        .writes()
        .into_iter()
        .find(|w| w.method == Method::Put)
        .unwrap();
    assert_eq!(
        put.body.unwrap(),
        json!({ "type": 0, "allow": (1u64 << 40).to_string(), "deny": "2048" })
    );
    assert_eq!(out.data.unwrap()["deny"], json!(["SendMessages"]));
}

#[tokio::test]
async fn set_permissions_refuses_conflicts_and_exposure() {
    let (server, fake) = world(false);
    let e = run(&server, "discord_set_channel_permissions", json!({ "channel": GENERAL, "target": "@everyone", "allow": ["ViewChannel"], "deny": ["ViewChannel"] }))
        .await
        .unwrap_err();
    assert!(e.is("CONFLICTING_ARGS"));
    fake.on(
        Method::Get,
        &format!("/channels/{GENERAL}"),
        json!({ "id": GENERAL, "type": 0, "guild_id": GUILD, "permission_overwrites": [
        { "id": GUILD, "type": 0, "allow": "0", "deny": "1024" }
    ] }),
    );
    let e = run(
        &server,
        "discord_set_channel_permissions",
        json!({ "channel": GENERAL, "target": "@everyone", "allow": ["ViewChannel"] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("EXPOSES_CHANNEL"));
    let e = run(&server, "discord_set_channel_permissions", json!({ "channel": GENERAL, "target": "Moderator", "allow": ["ManageMessages", "ViewChannel"] }))
        .await
        .unwrap_err();
    assert!(e.is("ELEVATED_PERMISSION"));
    assert!(fake.writes().is_empty());
}

#[tokio::test]
async fn edit_channel_sync_moves_through_the_positions_route() {
    let (server, fake) = world(true);
    fake.on(
        Method::Get,
        &format!("/channels/{GENERAL}"),
        json!({ "id": GENERAL, "type": 0, "guild_id": GUILD }),
    );
    run(
        &server,
        "discord_edit_channel",
        json!({ "channel": GENERAL, "category": "Staff", "sync_permissions": true }),
    )
    .await
    .unwrap();
    let writes = fake.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].route, format!("/guilds/{GUILD}/channels"));
    assert_eq!(
        writes[0].body.clone().unwrap(),
        json!([{ "id": GENERAL, "parent_id": CATEGORY, "lock_permissions": true }])
    );
    let e = run(
        &server,
        "discord_edit_channel",
        json!({ "channel": GENERAL, "sync_permissions": true }),
    )
    .await
    .unwrap_err();
    assert!(e.is("MISSING_ARG"));
}

#[tokio::test]
async fn reorder_channels_rejects_mixed_scopes() {
    let (server, _) = world(false);
    let e = run(
        &server,
        "discord_reorder_channels",
        json!({ "order": ["general", "random"] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("MIXED_SCOPE"));
}

// --- Members, roles, moderation ---------------------------------------------

#[tokio::test]
async fn member_roles_collapse_into_one_patch() {
    let (server, fake) = world(false);
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/{ALICE}"),
        json!({ "user": { "id": ALICE, "username": "alice" }, "roles": [MOD_ROLE] }),
    );
    let out = run(
        &server,
        "discord_manage_member_roles",
        json!({ "member": ALICE, "add": ["Assistant"], "remove": ["Moderator"] }),
    )
    .await;
    // Assistant holds Manage Roles, so it is refused with destructive actions off.
    assert!(out.unwrap_err().is("ELEVATED_PERMISSION"));
    let (server, fake) = world(true);
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/{ALICE}"),
        json!({ "user": { "id": ALICE, "username": "alice" }, "roles": [MOD_ROLE] }),
    );
    let out = run(
        &server,
        "discord_manage_member_roles",
        json!({ "member": ALICE, "add": ["Assistant"], "remove": ["Moderator"] }),
    )
    .await
    .unwrap();
    assert_eq!(
        out.data.unwrap(),
        json!({ "applied": ["+Assistant", "-Moderator"] })
    );
    let w = fake.writes();
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].body.clone().unwrap(), json!({ "roles": [BOT_ROLE] }));
}

#[tokio::test]
async fn member_roles_report_all_failed() {
    let (server, fake) = world(true);
    fake.fail(
        Method::Patch,
        &format!("/members/{ALICE}"),
        api(403, 50013, "Missing Permissions"),
    );
    fake.fail(
        Method::Put,
        &format!("/roles/{MOD_ROLE}"),
        api(403, 50013, "Missing Permissions"),
    );
    fake.fail(
        Method::Put,
        &format!("/roles/{ADMIN_ROLE}"),
        api(403, 50013, "Missing Permissions"),
    );
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/{ALICE}"),
        json!({ "user": { "id": ALICE, "username": "alice" }, "roles": [] }),
    );
    let e = run(
        &server,
        "discord_manage_member_roles",
        json!({ "member": ALICE, "add": ["Moderator", "Admin"] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("ROLE_CHANGE_FAILED"));
    let e = run(
        &server,
        "discord_manage_member_roles",
        json!({ "member": ALICE, "add": ["Moderator"] }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.tool().unwrap().code,
        Some(crate::errors::Code::Num(50013))
    );
}

#[tokio::test]
async fn manage_role_gates_elevated_grants_and_sends_colors() {
    let (server, fake) = world(false);
    let e = run(
        &server,
        "discord_manage_role",
        json!({ "action": "create", "name": "Bans", "permissions": ["BanMembers"] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("ELEVATED_PERMISSION"));
    fake.on(
        Method::Post,
        &format!("/guilds/{GUILD}/roles"),
        json!({ "id": "400000000000000009", "name": "Fancy", "position": 1, "permissions": "0" }),
    );
    run(
        &server,
        "discord_manage_role",
        json!({ "action": "create", "name": "Fancy", "color": "#ff0000", "secondary_color": 255 }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].body.clone().unwrap()["colors"],
        json!({ "primary_color": 16_711_680, "secondary_color": 255 })
    );
    let e = run(
        &server,
        "discord_manage_role",
        json!({ "action": "create", "name": "x", "secondary_color": 255 }),
    )
    .await
    .unwrap_err();
    assert!(e.is("MISSING_ARG"));
    let e = run(
        &server,
        "discord_manage_role",
        json!({ "action": "delete", "role": "Moderator" }),
    )
    .await
    .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
}

#[tokio::test]
async fn moderation_gate_allows_unban_only() {
    let (server, fake) = world(false);
    let e = run(
        &server,
        "discord_moderate_member",
        json!({ "action": "ban", "member": ALICE }),
    )
    .await
    .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
    assert!(fake.calls().is_empty());
    let out = run(
        &server,
        "discord_moderate_member",
        json!({ "action": "unban", "member": ALICE }),
    )
    .await
    .unwrap();
    assert_eq!(out.summary, format!("Unbanned {ALICE} ({ALICE})."));
}

#[tokio::test]
async fn edit_member_renames_the_bot_through_me() {
    let (server, fake) = world(false);
    fake.on(
        Method::Patch,
        "/members/@me",
        json!({ "user": { "id": BOT, "username": "assistant" }, "nick": "Bot", "roles": [] }),
    );
    run(
        &server,
        "discord_edit_member",
        json!({ "member": BOT, "nickname": "Bot" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].route,
        format!("/guilds/{GUILD}/members/@me")
    );
    fake.on(
        Method::Patch,
        &format!("/members/{BOT}"),
        json!({ "user": { "id": BOT, "username": "assistant" }, "roles": [] }),
    );
    run(
        &server,
        "discord_edit_member",
        json!({ "member": BOT, "nickname": "Bot", "mute": true }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[1].route,
        format!("/guilds/{GUILD}/members/{BOT}")
    );
}

#[tokio::test]
async fn reorder_roles_checks_room_before_patching() {
    let (server, fake) = world(false);
    let e = run(
        &server,
        "discord_reorder_roles",
        json!({ "order": ["Admin", "Moderator", "@everyone"] }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "@everyone is always the lowest role and cannot be moved."
    );
    fake.on(
        Method::Patch,
        &format!("/guilds/{GUILD}/roles"),
        json!([{ "id": MOD_ROLE, "name": "Moderator", "position": 4 }]),
    );
    let out = run(
        &server,
        "discord_reorder_roles",
        json!({ "order": ["Moderator", "Admin"] }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].body.clone().unwrap(),
        json!([{ "id": MOD_ROLE, "position": 4 }, { "id": ADMIN_ROLE, "position": 3 }])
    );
    assert_eq!(
        out.summary,
        "Reordered 2 roles; highest is now \"Moderator\"."
    );
}

// --- Community -------------------------------------------------------------

#[tokio::test]
async fn scheduled_events_validate_times_locally() {
    let (server, fake) = world(false);
    let e = run(&server, "discord_scheduled_events", json!({ "action": "create", "name": "x", "start_time": "2020-01-01T00:00:00Z", "location": "here", "end_time": "2020-01-02T00:00:00Z" }))
        .await
        .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "start_time must be in the future."
    );
    let e = run(&server, "discord_scheduled_events", json!({ "action": "create", "name": "x", "start_time": "2099-01-02T00:00:00Z", "location": "here", "end_time": "2099-01-01T00:00:00Z" }))
        .await
        .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "end_time must be after start_time."
    );
    let e = run(&server, "discord_scheduled_events", json!({ "action": "create", "name": "x", "start_time": "2099-01-02T00:00:00Z", "location": "here" })).await.unwrap_err();
    assert!(e.is("MISSING_ARG"));
    let e = run(
        &server,
        "discord_scheduled_events",
        json!({ "action": "delete", "event": "x" }),
    )
    .await
    .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
    assert!(fake.writes().is_empty());
}

#[tokio::test]
async fn scheduled_event_create_external_body() {
    let (server, fake) = world(false);
    fake.on(Method::Post, "/scheduled-events", json!({ "id": "600000000000000001", "name": "Party", "entity_type": 3, "status": 1, "scheduled_start_time": "2099-01-01T00:00:00Z" }));
    let out = run(&server, "discord_scheduled_events", json!({ "action": "create", "name": "Party", "start_time": "2099-01-01T00:00:00Z", "end_time": "2099-01-01T02:00:00Z", "location": "Park", "reason": "fun" }))
        .await
        .unwrap();
    assert_eq!(
        out.summary,
        "Created external event \"Party\" (600000000000000001)."
    );
    let w = &fake.writes()[0];
    assert_eq!(w.reason.as_deref(), Some("fun"));
    assert_eq!(
        w.body.clone().unwrap(),
        json!({ "name": "Party", "privacy_level": 2, "scheduled_start_time": "2099-01-01T00:00:00Z", "scheduled_end_time": "2099-01-01T02:00:00Z", "entity_type": 3, "entity_metadata": { "location": "Park" } })
    );
}

#[tokio::test]
async fn automod_create_and_guards() {
    let (server, fake) = world(false);
    let e = run(&server, "discord_automod", json!({ "action": "create", "name": "x", "trigger": "spam", "actions": [{ "type": "timeout", "duration_seconds": 60 }] }))
        .await
        .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "A timeout action cannot be used with a spam rule."
    );
    let e = run(&server, "discord_automod", json!({ "action": "create", "name": "x", "trigger": "keyword", "keywords": ["bad"], "exempt_roles": ["@everyone"] }))
        .await
        .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
    let e = run(
        &server,
        "discord_automod",
        json!({ "action": "create", "name": "x", "trigger": "spam", "keywords": ["bad"] }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.tool().unwrap().message,
        "keywords does not apply to a spam rule."
    );
    let e = run(&server, "discord_automod", json!({ "action": "create", "name": "x", "trigger": "keyword", "keywords": ["bad"], "exempt_roles": ["Mod"] }))
        .await
        .unwrap_err();
    assert!(e.is("NOT_FOUND"), "exemptions match exactly");

    fake.on(Method::Post, "/auto-moderation/rules", json!({ "id": "700000000000000001", "name": "x", "enabled": true, "trigger_type": 1, "actions": [{ "type": 1 }], "exempt_roles": [], "exempt_channels": [] }));
    run(&server, "discord_automod", json!({ "action": "create", "name": "x", "trigger": "keyword", "keywords": ["bad"], "exempt_roles": ["Moderator"] })).await.unwrap();
    assert_eq!(
        fake.writes()[0].body.clone().unwrap(),
        json!({ "name": "x", "event_type": 1, "trigger_type": 1, "trigger_metadata": { "keyword_filter": ["bad"] }, "actions": [{ "type": 1 }], "enabled": true, "exempt_roles": [MOD_ROLE] })
    );
}

#[tokio::test]
async fn automod_edit_merges_metadata() {
    let (server, fake) = world(false);
    fake.on(Method::Get, "/auto-moderation/rules", json!([{ "id": "700000000000000001", "name": "Words", "enabled": true, "trigger_type": 1,
        "trigger_metadata": { "keyword_filter": ["a"], "allow_list": ["ok"] }, "actions": [{ "type": 1 }], "exempt_roles": [], "exempt_channels": [] }]));
    fake.on(Method::Patch, "/auto-moderation/rules/700000000000000001", json!({ "id": "700000000000000001", "name": "Words", "enabled": true, "trigger_type": 1, "actions": [], "exempt_roles": [], "exempt_channels": [] }));
    run(
        &server,
        "discord_automod",
        json!({ "action": "edit", "rule": "words", "keywords": ["b"] }),
    )
    .await
    .unwrap();
    assert_eq!(
        fake.writes()[0].body.clone().unwrap(),
        json!({ "trigger_metadata": { "keyword_filter": ["b"], "allow_list": ["ok"] } })
    );
    let e = run(
        &server,
        "discord_automod",
        json!({ "action": "edit", "rule": "words", "keywords": [] }),
    )
    .await
    .unwrap_err();
    assert!(e.is("DESTRUCTIVE_DISABLED"));
}

#[tokio::test]
async fn invites_parse_links_and_gate_revoke() {
    let (server, fake) = world(false);
    assert!(
        run(
            &server,
            "discord_manage_invites",
            json!({ "action": "revoke", "code": "abc" })
        )
        .await
        .unwrap_err()
        .is("DESTRUCTIVE_DISABLED")
    );
    let (server, fake2) = world(true);
    run(
        &server,
        "discord_manage_invites",
        json!({ "action": "revoke", "code": "https://discord.gg/abc123" }),
    )
    .await
    .unwrap();
    assert_eq!(fake2.writes()[0].route, "/invites/abc123");
    let e = run(
        &server,
        "discord_manage_invites",
        json!({ "action": "revoke", "code": "not a code!" }),
    )
    .await
    .unwrap_err();
    assert!(e.is("INVALID_ARGS"));
    assert!(fake.calls().is_empty());
}

#[tokio::test]
async fn emoji_file_needs_exactly_one_source() {
    let (server, _) = world(false);
    let e = run(
        &server,
        "discord_manage_emojis",
        json!({ "action": "create", "name": "party", "file": {} }),
    )
    .await
    .unwrap_err();
    assert!(
        e.tool()
            .unwrap()
            .message
            .ends_with("file: Give exactly one of path or url."),
        "{}",
        message_text(&e)
    );
}

// --- Events and whoami ------------------------------------------------------

#[tokio::test]
async fn recent_events_without_raw_payload() {
    let (server, _) = world(false);
    server.gateway.ingest("MESSAGE_CREATE", json!({ "id": "1", "channel_id": GENERAL, "content": "hello", "author": { "id": ALICE, "username": "alice" } }));
    let all: crate::gateway::Predicate = Arc::new(|_| true);
    let events = server.gateway.recent(&all, None, 10);
    assert_eq!(events.len(), 1);
    assert!(events[0].present(false).get("data").is_none());
    assert_eq!(events[0].present(true)["data"]["content"], "hello");
}

#[tokio::test]
async fn whoami_reports_standing_and_settings() {
    let (server, _) = world(false);
    let out = run(&server, "discord_whoami", json!({})).await.unwrap();
    assert_eq!(
        out.summary,
        format!("Connected as assistant ({BOT}), in 1 server.")
    );
    let data = out.data.unwrap();
    assert_eq!(data["servers"][0]["top_role"], "Assistant (position 5)");
    assert_eq!(
        data["servers"][0]["permissions"],
        json!(["ViewChannel", "ManageRoles"])
    );
    assert_eq!(data["destructive_actions_enabled"], false);
    assert_eq!(data["upload_dirs"], "anywhere");
    assert_eq!(data["default_guild"], Value::Null);
}

#[tokio::test]
async fn member_name_resolution_is_exact_for_removals() {
    let (server, fake) = world(true);
    fake.on(
        Method::Get,
        &format!("/guilds/{GUILD}/members/search"),
        json!([
            { "user": { "id": ALICE, "username": "alicewonder" }, "nick": null, "roles": [] }
        ]),
    );
    let e = run(
        &server,
        "discord_moderate_member",
        json!({ "action": "kick", "member": "alice" }),
    )
    .await
    .unwrap_err();
    assert!(
        e.is("NOT_FOUND"),
        "a prefix never picks the target of a kick"
    );
    let out = run(&server, "discord_get_member", json!({ "member": "alice" }))
        .await
        .unwrap();
    assert_eq!(out.data.unwrap()["id"], ALICE);
}
