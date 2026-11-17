//! End-to-end tests over the real stdio transport: the handshake, the tool
//! list, config errors and refusals that never reach Discord.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

const GUILD: &str = "100000000000000001";

struct Run {
    code: Option<i32>,
    stderr: String,
    responses: Vec<Value>,
}

fn run(env: &[(&str, &str)], messages: &[Value]) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_discord-mcp"));
    cmd.env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(root) = std::env::var("SYSTEMROOT") {
        cmd.env("SYSTEMROOT", root);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("binary starts");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let wanted = messages.iter().filter(|m| m.get("id").is_some()).count();

    for m in messages {
        writeln!(stdin, "{m}").expect("write");
    }
    let mut responses = Vec::new();
    let mut lines = BufReader::new(stdout).lines();
    while responses.len() < wanted {
        let Some(Ok(line)) = lines.next() else { break };
        let v: Value = serde_json::from_str(&line).expect("json line");
        if v.get("id").is_some() {
            responses.push(v);
        }
    }
    // Calls are handled concurrently, so answers can arrive in any order.
    responses.sort_by_key(|v| v["id"].as_i64());
    drop(stdin);
    let output = child.wait_with_output().expect("exit");
    Run {
        code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        responses,
    }
}

fn init() -> Vec<Value> {
    vec![
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    ]
}

fn token() -> (&'static str, &'static str) {
    (
        "DISCORD_TOKEN",
        "test-token-that-is-long-enough-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    )
}

#[test]
fn config_errors_exit_78() {
    let r = run(&[], &[]);
    assert_eq!(r.code, Some(78));
    assert!(
        r.stderr
            .contains("  - DISCORD_TOKEN: DISCORD_TOKEN is missing or empty")
    );
    assert!(
        r.stderr.contains(
            "https://discord.com/developers/applications -> your app -> Bot -> Reset Token"
        )
    );
}

#[test]
fn handshake_and_tool_list() {
    let mut msgs = init();
    msgs.push(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let r = run(&[token(), ("DISCORD_DEFAULT_GUILD", GUILD)], &msgs);
    assert_eq!(
        r.code,
        Some(0),
        "exits cleanly when stdin closes: {}",
        r.stderr
    );
    assert!(
        r.stderr
            .contains("ready: 35 tools, destructive actions disabled"),
        "{}",
        r.stderr
    );

    let info = &r.responses[0]["result"];
    assert_eq!(info["serverInfo"]["name"], "discord-mcp");
    assert_eq!(info["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["capabilities"]["tools"]["listChanged"], true);
    assert!(
        info["instructions"]
            .as_str()
            .unwrap()
            .contains("are \ndisabled")
            || info["instructions"].as_str().unwrap().contains("disabled;")
    );

    let tools = r.responses[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 35);
    assert_eq!(tools[0]["name"], "discord_whoami");
    assert_eq!(tools[0]["inputSchema"]["additionalProperties"], false);
    assert!(tools.iter().all(|t| t["name"] != "discord_delete_channel"));
}

#[test]
fn destructive_enables_every_tool() {
    let mut msgs = init();
    msgs.push(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let r = run(
        &[
            token(),
            ("DISCORD_DEFAULT_GUILD", GUILD),
            ("DISCORD_ALLOW_DESTRUCTIVE", "true"),
        ],
        &msgs,
    );
    assert_eq!(
        r.responses[1]["result"]["tools"].as_array().unwrap().len(),
        38
    );
    assert!(r.stderr.contains("destructive actions ENABLED"));
}

#[test]
fn refusals_come_back_as_error_results() {
    let mut msgs = init();
    msgs.push(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "discord_manage_role", "arguments": { "action": "delete", "role": "x" } } }));
    msgs.push(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "discord_batch", "arguments": { "operations": [{ "tool": "discord_batch", "args": {} }] } } }));
    msgs.push(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "discord_send_message", "arguments": { "channel": "200000000000000001", "nope": 1 } } }));
    let r = run(&[token(), ("DISCORD_DEFAULT_GUILD", GUILD)], &msgs);
    let text = |i: usize| {
        r.responses[i]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(text(1).starts_with("Refused: \"discord_manage_role delete\" is a destructive action"));
    assert_eq!(r.responses[1]["result"]["isError"], true);
    assert!(text(2).starts_with("discord_batch cannot contain another discord_batch."));
    assert!(text(3).starts_with("Invalid arguments for discord_send_message: "));
}
