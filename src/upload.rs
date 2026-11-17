//! Loads attachments from disk or the web, refusing anything an injected
//! instruction could use to exfiltrate data.
//!
//! Local paths are confined to the configured roots (checked after resolving
//! symlinks) and never match obvious secret files; URLs must be public http(s)
//! hosts, re-checked on every redirect and at connect time, so DNS tricks
//! cannot reach internal services.

use crate::errors::{Error, Result, ToolError};
use crate::rest::RawFile;
use regex::Regex;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Sanity cap on one upload; Discord enforces the real (boost-dependent) limit.
pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, Default)]
pub struct UploadSource {
    pub path: Option<String>,
    pub url: Option<String>,
    pub name: Option<String>,
    pub spoiler: bool,
}

pub struct UploadPolicy<'a> {
    /// Directories local uploads may come from; None means anywhere.
    pub roots: Option<&'a [String]>,
    pub cancel: Option<&'a CancellationToken>,
    /// Strings that must never leave the machine, such as the bot token.
    pub secrets: Vec<String>,
    /// Per-file cap for this caller; falls back to MAX_UPLOAD_BYTES.
    pub max_bytes: Option<u64>,
}

struct Loaded {
    name: String,
    data: Vec<u8>,
    content_type: Option<String>,
}

pub async fn load_upload(source: &UploadSource, policy: &UploadPolicy<'_>) -> Result<RawFile> {
    let limit = policy.max_bytes.unwrap_or(MAX_UPLOAD_BYTES);
    let loaded = match &source.path {
        Some(path) => {
            let loaded = load_path(path, policy.roots, limit).await?;
            assert_no_secrets(&loaded.data, path, &policy.secrets)?;
            loaded
        }
        None => download(source.url.as_deref().unwrap_or(""), policy.cancel, limit).await?,
    };

    let mut name = clean_name(source.name.as_deref().unwrap_or(&loaded.name));
    if source.spoiler && !name.starts_with("SPOILER_") {
        name = format!("SPOILER_{name}");
    }
    Ok(RawFile {
        name,
        data: loaded.data,
        content_type: loaded.content_type,
    })
}

/// Loads several attachments one at a time, capping their combined size.
pub async fn load_uploads(
    sources: &[UploadSource],
    policy: &UploadPolicy<'_>,
) -> Result<Vec<RawFile>> {
    let mut files = Vec::new();
    let mut total: u64 = 0;
    for source in sources {
        let file = load_upload(source, policy).await?;
        total += file.data.len() as u64;
        if total > MAX_UPLOAD_BYTES {
            return Err(ToolError::new(format!(
                "The attachments add up to more than {} MB.",
                MAX_UPLOAD_BYTES / 1_048_576
            ))
            .code("FILE_TOO_LARGE")
            .hint("Send fewer or smaller files per message.")
            .into());
        }
        files.push(file);
    }
    Ok(files)
}

static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----").expect("valid regex")
});

/// Private keys and the bot token are refused by content, so renaming a copy does not get them out.
fn assert_no_secrets(data: &[u8], path: &str, secrets: &[String]) -> Result<()> {
    let latin1: String = data.iter().map(|&b| char::from(b)).collect();
    // A NUL byte suggests UTF-16, as Windows PowerShell writes by default; scan that decoding too.
    let text = if data.contains(&0) {
        let units: Vec<u16> = data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        format!("{latin1}\n{}", String::from_utf16_lossy(&units))
    } else {
        latin1
    };
    let leaked = PRIVATE_KEY.is_match(&text)
        || secrets
            .iter()
            .any(|s| s.len() >= 16 && text.contains(s.as_str()));
    if leaked {
        return Err(ToolError::new(format!(
            "Refused to upload \"{path}\": it contains a private key or the bot token."
        ))
        .code("PATH_NOT_ALLOWED")
        .hint("Secrets are never uploaded.")
        .into());
    }
    Ok(())
}

/// File names that hold credentials often enough that uploading one is never the intent.
static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$")
        .expect("valid regex")
});
/// Directories whose contents are secrets or configuration, wherever they sit.
static SECRET_DIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|gcloud)$")
        .expect("valid regex")
});

/// `path.isAbsolute` for the platform.
fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        matches!(b.first(), Some(b'/' | b'\\'))
            || (b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && matches!(b[2], b'/' | b'\\'))
    } else {
        path.starts_with('/')
    }
}

/// `path.resolve`: absolute, with `.` and `..` folded away lexically.
fn resolve(path: &str) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_default();
    let joined = base.join(path);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn comparable(p: &Path) -> Vec<String> {
    p.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| {
            let s = c.as_os_str().to_string_lossy().replace('\\', "/");
            if cfg!(windows) { s.to_lowercase() } else { s }
        })
        .collect()
}

fn inside_any(file: &Path, roots: &[String]) -> bool {
    let file = comparable(file);
    roots.iter().any(|root| {
        let real_root = dunce::canonicalize(root).unwrap_or_else(|_| resolve(root));
        let root = comparable(&real_root);
        file.len() >= root.len() && file[..root.len()] == root[..]
    })
}

async fn load_path(path: &str, roots: Option<&[String]>, limit: u64) -> Result<Loaded> {
    if !is_absolute(path) {
        return Err(
            ToolError::new(format!("\"{path}\" is not an absolute path."))
                .code("INVALID_PATH")
                .hint("Pass the full absolute path of the file to upload.")
                .into(),
        );
    }
    // A UNC path makes Windows authenticate to whatever host it names the moment it is touched.
    let b = path.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\') {
        return Err(ToolError::new(format!(
            "Uploading \"{path}\" is not allowed: network paths are not supported."
        ))
        .code("PATH_NOT_ALLOWED")
        .hint("Copy the file to a local folder first.")
        .into());
    }

    let outside = || -> Error {
        ToolError::new(format!(
            "Uploading \"{path}\" is not allowed: it is outside the permitted upload folders."
        ))
        .code("PATH_NOT_ALLOWED")
        .hint(format!(
            "Uploads may come from: {}. The operator can widen this with DISCORD_UPLOAD_DIRS \
                 (a path-separated list, or * for anywhere).",
            roots.unwrap_or(&[]).join(", ")
        ))
        .into()
    };

    // Checked on the literal path first, so nothing outside the roots is even probed;
    // then again after resolving symlinks.
    if let Some(roots) = roots
        && !inside_any(&resolve(path), roots)
    {
        return Err(outside());
    }

    let real = dunce::canonicalize(path).ok();
    let info = match &real {
        Some(r) => tokio::fs::metadata(r).await.ok(),
        None => None,
    };
    let (Some(real), Some(info)) = (real, info.filter(std::fs::Metadata::is_file)) else {
        return Err(ToolError::new(format!("No file at \"{path}\"."))
            .code("FILE_NOT_FOUND")
            .hint("Pass an absolute path to an existing file.")
            .into());
    };

    if let Some(roots) = roots
        && !inside_any(&real, roots)
    {
        return Err(outside());
    }

    let base = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let secret_dir = real
        .components()
        .any(|c| SECRET_DIR.is_match(&c.as_os_str().to_string_lossy()));
    if SECRET_NAME.is_match(&base) || secret_dir {
        return Err(ToolError::new(format!("Refused to upload \"{path}\": it looks like a credentials or key file."))
            .code("PATH_NOT_ALLOWED")
            .hint("Secrets are never uploaded. If this file is safe to share, copy it under a neutral name first.")
            .into());
    }

    // Checked on the stat size, so an oversized file is never loaded into memory.
    if info.len() > limit {
        return Err(ToolError::new(format!(
            "\"{path}\" is too large to upload ({} KiB; the limit is {} KiB).",
            info.len().div_ceil(1024),
            limit / 1024
        ))
        .code("FILE_TOO_LARGE")
        .into());
    }

    let data = tokio::fs::read(&real)
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    Ok(Loaded {
        name: base,
        data,
        content_type: None,
    })
}

/// Strips anything that would make Discord (or a downloader) treat the name as a path.
fn clean_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if c == '\\' || c == '/' || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = crate::js::prefix16(crate::js::trim(&replaced), 200).to_string();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

fn in_v4(a: Ipv4Addr, net: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(a) & mask) == (u32::from(Ipv4Addr::from(net)) & mask)
}

fn in_v6(a: Ipv6Addr, net: Ipv6Addr, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    (u128::from(a) & mask) == (u128::from(net) & mask)
}

/// True when an address is not a public unicast address: loopback, private,
/// link-local, metadata, multicast and the v6 forms that smuggle a v4 address.
pub fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(a) => [
            ([0, 0, 0, 0], 8),
            ([10, 0, 0, 0], 8),
            ([100, 64, 0, 0], 10),
            ([127, 0, 0, 0], 8),
            ([169, 254, 0, 0], 16),
            ([172, 16, 0, 0], 12),
            ([192, 0, 0, 0], 24),
            ([192, 168, 0, 0], 16),
            ([198, 18, 0, 0], 15),
            ([224, 0, 0, 0], 4),
            ([240, 0, 0, 0], 4),
        ]
        .iter()
        .any(|(net, p)| in_v4(a, *net, *p)),
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return is_private_address(IpAddr::V4(v4));
            }
            let blocked: [(&str, u32); 8] = [
                ("::", 96),
                ("::1", 128),
                ("fec0::", 10),
                ("fc00::", 7),
                ("fe80::", 10),
                ("ff00::", 8),
                ("64:ff9b::", 96),
                ("2002::", 16),
            ];
            blocked
                .iter()
                .any(|(net, p)| net.parse::<Ipv6Addr>().is_ok_and(|n| in_v6(a, n, *p)))
        }
    }
}

fn blocked_url(url: &str) -> Error {
    ToolError::new(format!(
        "Refused to download {url}: it points at a private or local network address."
    ))
    .code("URL_NOT_ALLOWED")
    .hint("Only public http(s) URLs can be attached.")
    .into()
}

fn download_failed(message: String) -> Error {
    ToolError::new(message).code("DOWNLOAD_FAILED").into()
}

const PRIVATE_MARKER: &str = "EPRIVATEADDR";

/// DNS resolution that refuses private addresses. Running inside the connect
/// (rather than as a pre-check) closes the DNS-rebinding gap.
struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() || addrs.iter().any(|a| is_private_address(a.ip())) {
                return Err(format!("{PRIVATE_MARKER}: private address for {host}").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn parse_http_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| {
        Error::from(ToolError::new(format!("\"{raw}\" is not a valid URL.")).code("INVALID_URL"))
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ToolError::new(format!(
            "Refused to download {raw}: only http and https URLs are supported."
        ))
        .code("URL_NOT_ALLOWED")
        .into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::new(format!(
            "Refused to download {raw}: URLs with embedded credentials are not supported."
        ))
        .code("URL_NOT_ALLOWED")
        .into());
    }
    match url.host() {
        Some(url::Host::Ipv4(a)) if is_private_address(IpAddr::V4(a)) => {
            return Err(blocked_url(raw));
        }
        Some(url::Host::Ipv6(a)) if is_private_address(IpAddr::V6(a)) => {
            return Err(blocked_url(raw));
        }
        Some(url::Host::Domain(d)) => {
            let d = d.to_lowercase();
            if d == "localhost" || d == "localhost." || d.ends_with(".localhost") {
                return Err(blocked_url(raw));
            }
        }
        _ => {}
    }
    Ok(url)
}

fn chain_text(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

fn download_error(error: &reqwest::Error, url: &str) -> Error {
    let text = chain_text(error);
    if text.contains(PRIVATE_MARKER) {
        return blocked_url(url);
    }
    if error.is_timeout() {
        return download_failed(format!("Downloading {url} was cancelled or timed out."));
    }
    download_failed(format!("Downloading {url} failed: {text}"))
}

async fn download(raw: &str, cancel: Option<&CancellationToken>, limit: u64) -> Result<Loaded> {
    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);
    let work = download_inner(raw, limit);
    tokio::select! {
        r = tokio::time::timeout(DOWNLOAD_TIMEOUT, work) => r.unwrap_or_else(|_| Err(download_failed(format!("Downloading {raw} was cancelled or timed out.")))),
        () = cancel.cancelled() => Err(download_failed(format!("Downloading {raw} was cancelled or timed out."))),
    }
}

async fn download_inner(raw: &str, limit: u64) -> Result<Loaded> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(PublicResolver))
        .user_agent("discord-mcp (attachment fetch)")
        .build()
        .map_err(|e| download_failed(format!("Downloading {raw} failed: {e}")))?;

    let mut url = parse_http_url(raw)?;
    let mut hop = 0;
    loop {
        let mut response = client
            .get(url.clone())
            .header("accept", "*/*")
            .send()
            .await
            .map_err(|e| download_error(&e, raw))?;
        let status = response.status().as_u16();

        if (300..400).contains(&status)
            && let Some(location) = response
                .headers()
                .get("location")
                .and_then(|l| l.to_str().ok())
        {
            if hop >= MAX_REDIRECTS {
                return Err(download_failed(format!(
                    "Downloading {raw} failed: too many redirects."
                )));
            }
            let next = url.join(location).map_err(|_| {
                Error::from(
                    ToolError::new(format!("\"{location}\" is not a valid URL."))
                        .code("INVALID_URL"),
                )
            })?;
            url = parse_http_url(next.as_str())?;
            hop += 1;
            continue;
        }

        if !(200..300).contains(&status) {
            return Err(download_failed(format!(
                "Downloading {raw} failed with HTTP {status}."
            )));
        }

        let declared: u64 = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if declared > limit {
            return Err(ToolError::new(format!("{raw} is too large to upload."))
                .code("FILE_TOO_LARGE")
                .into());
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(|v| crate::js::trim(v).to_string())
            .filter(|v| !v.is_empty());

        // Content-Length can be absent or lie, so the cap is enforced on the bytes themselves.
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| download_error(&e, raw))?
        {
            data.extend_from_slice(&chunk);
            if data.len() as u64 > limit {
                return Err(ToolError::new(format!("{raw} is too large to upload."))
                    .code("FILE_TOO_LARGE")
                    .into());
            }
        }

        let last = url.path().rsplit('/').next().unwrap_or("");
        let name = percent_encoding::percent_decode_str(last)
            .decode_utf8()
            .map_or_else(|_| last.to_string(), |d| d.into_owned());
        let name = if name.is_empty() {
            "file".to_string()
        } else {
            name
        };
        return Ok(Loaded {
            name,
            data,
            content_type,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ranges() {
        for a in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "192.168.1.1",
            "::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "0.0.0.0",
        ] {
            assert!(is_private_address(a.parse().unwrap()), "{a}");
        }
        for a in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(!is_private_address(a.parse().unwrap()), "{a}");
        }
    }

    #[test]
    fn url_checks() {
        assert!(
            parse_http_url("http://127.0.0.1/x")
                .unwrap_err()
                .is("URL_NOT_ALLOWED")
        );
        assert!(
            parse_http_url("http://localhost/x")
                .unwrap_err()
                .is("URL_NOT_ALLOWED")
        );
        assert!(
            parse_http_url("ftp://example.com/x")
                .unwrap_err()
                .is("URL_NOT_ALLOWED")
        );
        assert!(
            parse_http_url("https://user:pw@example.com/x")
                .unwrap_err()
                .is("URL_NOT_ALLOWED")
        );
        assert!(parse_http_url("nope").unwrap_err().is("INVALID_URL"));
        assert!(parse_http_url("https://example.com/a.png").is_ok());
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("../a/b.txt"), ".._a_b.txt");
        assert_eq!(clean_name("  "), "file");
    }

    #[test]
    fn secret_content_is_refused() {
        let key = b"-----BEGIN OPENSSH PRIVATE KEY-----\nabc";
        assert!(assert_no_secrets(key, "x", &[]).is_err());
        let token = "abcdefghijklmnopqrstuvwxyz";
        assert!(
            assert_no_secrets(format!("x{token}y").as_bytes(), "x", &[token.to_string()]).is_err()
        );
        let utf16: Vec<u8> = "-----BEGIN PRIVATE KEY-----"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(assert_no_secrets(&utf16, "x", &[]).is_err());
        assert!(assert_no_secrets(b"hello", "x", &[]).is_ok());
    }

    #[tokio::test]
    async fn paths_are_confined() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("report.txt");
        std::fs::write(&inside, "ok").unwrap();
        let outside = dir.path().join("other.txt");
        std::fs::write(&outside, "no").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let policy = UploadPolicy {
            roots: Some(&roots),
            cancel: None,
            secrets: vec![],
            max_bytes: None,
        };

        let ok = load_upload(
            &UploadSource {
                path: Some(inside.to_string_lossy().into_owned()),
                ..Default::default()
            },
            &policy,
        )
        .await
        .unwrap();
        assert_eq!(ok.name, "report.txt");
        assert_eq!(ok.data, b"ok");

        let err = load_upload(
            &UploadSource {
                path: Some(outside.to_string_lossy().into_owned()),
                ..Default::default()
            },
            &policy,
        )
        .await
        .unwrap_err();
        assert!(err.is("PATH_NOT_ALLOWED"));

        let env = root.join(".env");
        std::fs::write(&env, "A=1").unwrap();
        let err = load_upload(
            &UploadSource {
                path: Some(env.to_string_lossy().into_owned()),
                ..Default::default()
            },
            &policy,
        )
        .await
        .unwrap_err();
        assert!(err.is("PATH_NOT_ALLOWED"));

        let rel = load_upload(
            &UploadSource {
                path: Some("relative.txt".into()),
                ..Default::default()
            },
            &policy,
        )
        .await
        .unwrap_err();
        assert!(rel.is("INVALID_PATH"));

        let spoiler = load_upload(
            &UploadSource {
                path: Some(inside.to_string_lossy().into_owned()),
                spoiler: true,
                name: Some("x.txt".into()),
                ..Default::default()
            },
            &policy,
        )
        .await
        .unwrap();
        assert_eq!(spoiler.name, "SPOILER_x.txt");
    }
}
