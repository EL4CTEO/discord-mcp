//! discord-mcp: an MCP server that lets AI agents run a Discord bot.
//!
//! stdout carries the JSON-RPC stream, so every diagnostic goes to stderr - a
//! stray print to stdout corrupts the protocol and the client disconnects.

mod cache;
mod config;
mod errors;
mod format;
mod gateway;
mod js;
mod json;
mod limiter;
mod permissions;
mod render;
mod resolve;
mod rest;
mod server;
mod text;
mod tools;
mod upload;
mod version;

use rmcp::ServiceExt;
use std::sync::Arc;
use std::time::Duration;

/// EX_CONFIG from sysexits.h.
const EXIT_CONFIG: i32 = 78;

fn main() {
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let config = match config::load_config(&env) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("{}", e.0);
            std::process::exit(EXIT_CONFIG);
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("discord-mcp failed to start: {e}");
            std::process::exit(1);
        }
    };

    let code = runtime.block_on(async move {
        match run(config).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("discord-mcp failed to start: {e}");
                1
            }
        }
    });
    // Never hang on exit: background sockets must not keep the process alive.
    runtime.shutdown_timeout(Duration::from_millis(500));
    std::process::exit(code);
}

async fn run(config: Arc<config::Config>) -> Result<(), String> {
    let server = server::DiscordServer::new(Arc::clone(&config)).map_err(|e| e.to_string())?;
    let tool_count = server.advertised().len();
    let resolver = Arc::clone(&server.resolver);
    let gateway = Arc::clone(&server.gateway);

    let service = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| e.to_string())?;
    eprintln!(
        "discord-mcp {} ready: {tool_count} tools, destructive actions {}",
        version::VERSION,
        if config.allow_destructive {
            "ENABLED"
        } else {
            "disabled"
        }
    );

    // Warm the name-resolution caches while the client is still handshaking.
    tokio::spawn(async move { resolver.warm().await });

    let stop = service.cancellation_token();
    tokio::select! {
        // The client closing stdin is how it says goodbye.
        _ = service.waiting() => {}
        () = shutdown_signal() => stop.cancel(),
    }

    // Never hang on exit: an unresponsive socket must not keep the process alive.
    let _ = tokio::time::timeout(Duration::from_secs(3), gateway.disconnect()).await;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
