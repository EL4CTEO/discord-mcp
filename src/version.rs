//! The package version, from Cargo.toml, so the MCP handshake and the REST
//! user agent never drift from what was actually released.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
