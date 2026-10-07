//! Connectors: MCP servers that give Claude Code and Claude Desktop access to
//! outside services (Google, Microsoft 365, GitHub, the browser and so on).
//!
//! Claude Code keeps them under `mcpServers` in `~/.claude.json`; Claude Desktop
//! (third-party mode) keeps them under `managedMcpServers` in the applied
//! configLibrary profile. Both files are owned by other programs, so edits only
//! touch the one entry being changed and keep every other byte in place.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};

use crate::agents::{agent_configuration_environment, claude_desktop_config_paths};
use crate::core_config::replace_file_atomically;

const GOOGLE_WORKSPACE_PACKAGE: &str = "workspace-mcp==2.0.1";
const GOOGLE_SERVICES: [&str; 5] = ["gmail", "calendar", "drive", "docs", "sheets"];
const GITHUB_URL: &str = "https://api.githubcopilot.com/mcp/";
const GITHUB_READONLY_URL: &str = "https://api.githubcopilot.com/mcp/readonly";
const GITHUB_PLUGIN_ID: &str = "github@claude-plugins-official";
const MICROSOFT_365_URL: &str = "https://microsoft365.mcp.claude.com/mcp";
const FIRECRAWL_URL: &str = "https://mcp.firecrawl.dev/v2/mcp";
const HISTORY_LIMIT: usize = 30;
const FILE_BACKUP_LIMIT: usize = 20;
const STDIO_TEST_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Catalog

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectorId {
    Google,
    Microsoft365,
    GitHub,
    Playwright,
    Windows,
    Firecrawl,
}

impl ConnectorId {
    const ALL: [ConnectorId; 6] = [
        ConnectorId::Google,
        ConnectorId::Microsoft365,
        ConnectorId::GitHub,
        ConnectorId::Playwright,
        ConnectorId::Windows,
        ConnectorId::Firecrawl,
    ];

    fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|id| id.key() == value)
            .ok_or_else(|| format!("Unknown connector: {value}"))
    }

    fn key(self) -> &'static str {
        match self {
            ConnectorId::Google => "google",
            ConnectorId::Microsoft365 => "microsoft365",
            ConnectorId::GitHub => "github",
            ConnectorId::Playwright => "playwright",
            ConnectorId::Windows => "windows",
            ConnectorId::Firecrawl => "firecrawl",
        }
    }

    /// Entry name written for each target. Existing hand-made entries are
    /// recognised case-insensitively so they are adopted, not duplicated.
    fn entry_name(self, target: Target) -> &'static str {
        match (self, target) {
            (ConnectorId::Google, Target::Code) => "google-workspace",
            (ConnectorId::Google, Target::Desktop) => "Google-Workspace",
            (ConnectorId::Microsoft365, Target::Code) => "microsoft-365",
            (ConnectorId::Microsoft365, Target::Desktop) => "Microsoft-365",
            (ConnectorId::GitHub, Target::Code) => "github",
            (ConnectorId::GitHub, Target::Desktop) => "GitHub",
            (ConnectorId::Playwright, Target::Code) => "playwright",
            (ConnectorId::Playwright, Target::Desktop) => "Playwright",
            (ConnectorId::Windows, Target::Code) => "windows-mcp",
            (ConnectorId::Windows, Target::Desktop) => "Windows-MCP",
            (ConnectorId::Firecrawl, Target::Code) => "firecrawl",
            (ConnectorId::Firecrawl, Target::Desktop) => "Firecrawl",
        }
    }

    fn access_levels(self) -> &'static [&'static str] {
        match self {
            ConnectorId::Google => &["readonly", "drafts", "full"],
            ConnectorId::GitHub => &["readonly", "full"],
            _ => &[],
        }
    }

    fn secret_names(self) -> &'static [&'static str] {
        match self {
            ConnectorId::Google => &["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
            ConnectorId::GitHub => &["GITHUB_TOKEN"],
            ConnectorId::Microsoft365 => &["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID"],
            _ => &[],
        }
    }

    /// The secrets one target's entry needs. Claude Code reaches Microsoft 365
    /// through Anthropic's hosted connector, which needs none.
    fn secrets_for(self, target: Target) -> &'static [&'static str] {
        match (self, target) {
            (ConnectorId::Microsoft365, Target::Code) => &[],
            _ => self.secret_names(),
        }
    }

    fn secrets_desktop_only(self) -> bool {
        self.secrets_for(Target::Code).is_empty() && !self.secret_names().is_empty()
    }
}

/// Values Claude Desktop accepts for a built-in Microsoft 365 entry's tenantId.
const MICROSOFT_TENANT_ALIASES: [&str; 3] = ["organizations", "common", "consumers"];

fn is_guid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Claude Desktop drops a built-in Microsoft 365 entry whose IDs are malformed
/// without saying so, so they are checked before anything is written.
fn check_microsoft_ids(secrets: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(tenant) = secrets.get("MICROSOFT_TENANT_ID").map(|value| value.trim()) {
        if !is_guid(tenant) && !MICROSOFT_TENANT_ALIASES.contains(&tenant.to_ascii_lowercase().as_str()) {
            return Err("invalid_secret:MICROSOFT_TENANT_ID".to_string());
        }
    }
    if let Some(client) = secrets.get("MICROSOFT_CLIENT_ID").map(|value| value.trim()) {
        if !is_guid(client) {
            return Err("invalid_secret:MICROSOFT_CLIENT_ID".to_string());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Target {
    #[serde(rename = "claudeCode")]
    Code,
    #[serde(rename = "claudeDesktop")]
    Desktop,
}

/// Programs the stdio connectors run. Resolved once per request.
#[derive(Clone, Debug, Default)]
struct Runtimes {
    uvx: Option<PathBuf>,
    playwright: Option<(PathBuf, PathBuf)>,
    windows_python: Option<PathBuf>,
}

impl Runtimes {
    fn detect(home: &Path, local_app_data: &Path) -> Self {
        let uvx = [home.join(".local/bin/uvx.exe"), home.join(".local/bin/uvx")]
            .into_iter()
            .chain(find_on_path("uvx"))
            .find(|path| path.is_file());
        let node = [PathBuf::from(r"C:\Program Files\nodejs\node.exe")]
            .into_iter()
            .chain(find_on_path("node"))
            .find(|path| path.is_file());
        let hub = local_app_data.join("TimAIHub");
        let playwright_cli = hub.join("playwright-mcp/node_modules/@playwright/mcp/cli.js");
        let windows_python = hub.join("windows-mcp/.venv/Scripts/python.exe");
        Runtimes {
            uvx,
            playwright: node
                .zip(Some(playwright_cli))
                .filter(|(_, cli)| cli.is_file()),
            windows_python: Some(windows_python).filter(|path| path.is_file()),
        }
    }

    fn unavailable_reason(&self, id: ConnectorId) -> Option<&'static str> {
        match id {
            ConnectorId::Google if self.uvx.is_none() => Some("uvx"),
            ConnectorId::Playwright if self.playwright.is_none() => Some("playwright"),
            ConnectorId::Windows if self.windows_python.is_none() => Some("windows-mcp"),
            _ => None,
        }
    }
}

/// PATH for programs the app starts, with the user's `~/.local/bin` (where uv
/// and Claude Code install) added. Apps launched from the Start menu or tray
/// often lack it, so a bare `uvx` in a hand-written entry would not be found.
fn child_path(home: &Path) -> std::ffi::OsString {
    let local_bin = home.join(".local").join("bin");
    let mut dirs = vec![local_bin.clone()];
    if let Some(paths) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&paths).filter(|dir| *dir != local_bin));
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn find_on_path(program: &str) -> Vec<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{program}.exe"), program.to_string()]
    } else {
        vec![program.to_string()]
    };
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
                .collect()
        })
        .unwrap_or_default()
}

fn google_access_args(access: &str) -> Vec<String> {
    let mut args = vec![GOOGLE_WORKSPACE_PACKAGE.to_string(), "--single-user".to_string()];
    match access {
        "readonly" => {
            args.push("--read-only".to_string());
            args.push("--tools".to_string());
            args.extend(GOOGLE_SERVICES.iter().map(|s| s.to_string()));
        }
        "drafts" => {
            args.push("--permissions".to_string());
            args.push("gmail:drafts".to_string());
            args.extend(
                GOOGLE_SERVICES[1..]
                    .iter()
                    .map(|service| format!("{service}:readonly")),
            );
        }
        _ => {
            args.push("--tools".to_string());
            args.extend(GOOGLE_SERVICES.iter().map(|s| s.to_string()));
        }
    }
    args
}

fn google_access_from_args(args: &[String]) -> String {
    if args.iter().any(|arg| arg == "--read-only") {
        "readonly".to_string()
    } else if args.iter().any(|arg| arg == "--permissions") {
        "drafts".to_string()
    } else {
        "full".to_string()
    }
}

fn stdio_entry(target: Target, name: &str, command: &Path, args: Vec<String>, env: Option<Value>) -> Value {
    let mut entry = match target {
        Target::Code => json!({ "type": "stdio" }),
        Target::Desktop => json!({ "name": name, "transport": "stdio" }),
    };
    entry["command"] = json!(command.to_string_lossy());
    entry["args"] = json!(args);
    if let Some(env) = env {
        entry["env"] = env;
    }
    entry
}

fn http_entry(target: Target, name: &str, url: &str, headers: Option<Value>) -> Value {
    let mut entry = match target {
        Target::Code => json!({ "type": "http", "url": url }),
        Target::Desktop => json!({ "name": name, "transport": "http", "url": url }),
    };
    if let Some(headers) = headers {
        entry["headers"] = headers;
    }
    entry
}

/// Builds the entry a connector should have for one target.
fn build_entry(
    id: ConnectorId,
    target: Target,
    access: &str,
    secrets: &BTreeMap<String, String>,
    runtimes: &Runtimes,
) -> Result<Value, String> {
    let name = id.entry_name(target);
    let secret = |key: &str| {
        secrets
            .get(key)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .ok_or_else(|| format!("missing_secret:{key}"))
    };
    Ok(match id {
        ConnectorId::Google => {
            let uvx = runtimes.uvx.as_ref().ok_or("uvx is not installed")?;
            let env = json!({
                "GOOGLE_OAUTH_CLIENT_ID": secret("GOOGLE_OAUTH_CLIENT_ID")?,
                "GOOGLE_OAUTH_CLIENT_SECRET": secret("GOOGLE_OAUTH_CLIENT_SECRET")?,
                // workspace-mcp receives Google's sign-in callback on localhost.
                "OAUTHLIB_INSECURE_TRANSPORT": "1",
            });
            stdio_entry(target, name, uvx, google_access_args(access), Some(env))
        }
        ConnectorId::Microsoft365 => match target {
            Target::Code => http_entry(target, name, MICROSOFT_365_URL, None),
            // Claude Desktop's built-in connector signs in through the user's own
            // Entra app registration and asks for its default read set.
            Target::Desktop => json!({
                "name": name,
                "server": "microsoft365",
                "tenantId": secret("MICROSOFT_TENANT_ID")?,
                "clientId": secret("MICROSOFT_CLIENT_ID")?,
            }),
        },
        ConnectorId::GitHub => {
            let url = if access == "full" { GITHUB_URL } else { GITHUB_READONLY_URL };
            let headers = json!({ "Authorization": format!("Bearer {}", secret("GITHUB_TOKEN")?) });
            http_entry(target, name, url, Some(headers))
        }
        ConnectorId::Playwright => {
            let (node, cli) = runtimes.playwright.as_ref().ok_or("Playwright is not installed")?;
            let args = vec![cli.to_string_lossy().to_string(), "--extension".to_string()];
            stdio_entry(target, name, node, args, None)
        }
        ConnectorId::Windows => {
            let python = runtimes.windows_python.as_ref().ok_or("Windows-MCP is not installed")?;
            let env = json!({ "MODE": "local", "ANONYMIZED_TELEMETRY": "false", "PYTHONUTF8": "1" });
            stdio_entry(target, name, python, vec!["-m".into(), "windows_mcp".into()], Some(env))
        }
        ConnectorId::Firecrawl => http_entry(target, name, FIRECRAWL_URL, None),
    })
}

/// Reads the access level an existing entry was written with.
fn access_from_entry(id: ConnectorId, entry: &Value) -> Option<String> {
    match id {
        ConnectorId::Google => {
            let args: Vec<String> = entry
                .get("args")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|arg| arg.as_str().map(str::to_string))
                .collect();
            Some(google_access_from_args(&args))
        }
        ConnectorId::GitHub => {
            let url = entry.get("url").and_then(Value::as_str).unwrap_or_default();
            Some(if url.trim_end_matches('/').ends_with("/readonly") { "readonly" } else { "full" }.to_string())
        }
        _ => None,
    }
}

/// Pulls the secrets an existing entry carries so a rebuilt entry keeps them.
fn secrets_from_entry(id: ConnectorId, entry: &Value) -> BTreeMap<String, String> {
    let mut secrets = BTreeMap::new();
    match id {
        ConnectorId::Google => {
            for key in id.secret_names() {
                if let Some(value) = entry.pointer(&format!("/env/{key}")).and_then(Value::as_str) {
                    secrets.insert(key.to_string(), value.to_string());
                }
            }
        }
        ConnectorId::GitHub => {
            let token = entry
                .pointer("/headers/Authorization")
                .and_then(Value::as_str)
                .and_then(|header| header.strip_prefix("Bearer "))
                .map(str::trim)
                .filter(|token| !token.is_empty() && !token.contains("${"));
            if let Some(token) = token {
                secrets.insert("GITHUB_TOKEN".to_string(), token.to_string());
            }
        }
        ConnectorId::Microsoft365 => {
            for (key, field) in [("MICROSOFT_TENANT_ID", "tenantId"), ("MICROSOFT_CLIENT_ID", "clientId")] {
                if let Some(value) = entry.get(field).and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
                    secrets.insert(key.to_string(), value.trim().to_string());
                }
            }
        }
        _ => {}
    }
    secrets
}

// ---------------------------------------------------------------------------
// Order-preserving JSON editing

/// A JSON object read as ordered key/raw-value pairs, so untouched members are
/// written back exactly as they were.
struct OrderedObject(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor;
        impl<'de> Visitor<'de> for OrderedVisitor {
            type Value = OrderedObject;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? {
                    entries.push(entry);
                }
                Ok(OrderedObject(entries))
            }
        }
        deserializer.deserialize_map(OrderedVisitor)
    }
}

fn parse_ordered(text: &str) -> Result<OrderedObject, String> {
    serde_json::from_str(text).map_err(|error| format!("Not a JSON object: {error}"))
}

fn indent_after_first_line(text: &str, level: usize) -> String {
    let pad = "  ".repeat(level);
    text.lines()
        .enumerate()
        .map(|(index, line)| if index == 0 { line.to_string() } else { format!("{pad}{line}") })
        .collect::<Vec<_>>()
        .join("\n")
}

fn raw_from_value(value: &Value, level: usize) -> Result<Box<RawValue>, String> {
    let pretty = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    RawValue::from_string(indent_after_first_line(&pretty, level)).map_err(|error| error.to_string())
}

fn render_object(entries: &[(String, Box<RawValue>)], level: usize) -> String {
    if entries.is_empty() {
        return "{}".to_string();
    }
    let pad = "  ".repeat(level + 1);
    let body = entries
        .iter()
        .map(|(key, value)| format!("{pad}{}: {}", json!(key), value.get()))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("{{\n{body}\n{}}}", "  ".repeat(level))
}

fn render_array(items: &[Box<RawValue>], level: usize) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let pad = "  ".repeat(level + 1);
    let body = items
        .iter()
        .map(|item| format!("{pad}{}", item.get()))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("[\n{body}\n{}]", "  ".repeat(level))
}

fn set_member(object: &mut OrderedObject, key: &str, value: Box<RawValue>) {
    match object.0.iter_mut().find(|(existing, _)| existing == key) {
        Some((_, slot)) => *slot = value,
        None => object.0.push((key.to_string(), value)),
    }
}

/// Where one connector entry lives inside a config file.
#[derive(Clone, Copy, Debug)]
enum Container {
    /// `mcpServers` object keyed by name (Claude Code).
    CodeServers,
    /// `managedMcpServers` array of objects with a `name` (Claude Desktop).
    DesktopServers,
}

impl Container {
    fn for_target(target: Target) -> Self {
        match target {
            Target::Code => Container::CodeServers,
            Target::Desktop => Container::DesktopServers,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Container::CodeServers => "mcpServers",
            Container::DesktopServers => "managedMcpServers",
        }
    }
}

fn names_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

/// Finds a connector entry by name in a file's text.
fn read_entry(text: &str, container: Container, name: &str) -> Result<Option<Value>, String> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root = parse_ordered(text)?;
    let Some((_, raw)) = root.0.iter().find(|(key, _)| key == container.key()) else {
        return Ok(None);
    };
    match container {
        Container::CodeServers => {
            let servers = parse_ordered(raw.get())?;
            servers
                .0
                .iter()
                .find(|(key, _)| names_match(key, name))
                .map(|(_, value)| serde_json::from_str(value.get()).map_err(|error| error.to_string()))
                .transpose()
        }
        Container::DesktopServers => {
            let items = desktop_items(raw.get())?;
            Ok(items
                .iter()
                .filter_map(|item| serde_json::from_str::<Value>(item.get()).ok())
                .find(|item| item.get("name").and_then(Value::as_str).is_some_and(|n| names_match(n, name))))
        }
    }
}

/// Claude Desktop accepts the array either inline or as a JSON string.
fn desktop_items(raw: &str) -> Result<Vec<Box<RawValue>>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let inner = match parsed {
        Value::String(text) => text,
        Value::Null => return Ok(Vec::new()),
        _ => raw.to_string(),
    };
    serde_json::from_str(&inner).map_err(|error| format!("managedMcpServers is not a list: {error}"))
}

/// Returns the file text with one entry set (`Some`) or removed (`None`).
fn write_entry(text: &str, container: Container, name: &str, entry: Option<&Value>) -> Result<String, String> {
    let mut root = if text.trim().is_empty() { OrderedObject(Vec::new()) } else { parse_ordered(text)? };
    let existing = root.0.iter().find(|(key, _)| key == container.key()).map(|(_, raw)| raw.get().to_string());
    let rendered = match container {
        Container::CodeServers => {
            let mut servers = match existing.as_deref() {
                Some(raw) => parse_ordered(raw)?,
                None => OrderedObject(Vec::new()),
            };
            let position = servers.0.iter().position(|(key, _)| names_match(key, name));
            match (entry, position) {
                (Some(entry), Some(index)) => servers.0[index].1 = raw_from_value(entry, 2)?,
                (Some(entry), None) => servers.0.push((name.to_string(), raw_from_value(entry, 2)?)),
                (None, Some(index)) => {
                    servers.0.remove(index);
                }
                (None, None) => return Ok(text.to_string()),
            }
            render_object(&servers.0, 1)
        }
        Container::DesktopServers => {
            let mut items = match existing.as_deref() {
                Some(raw) => desktop_items(raw)?,
                None => Vec::new(),
            };
            let position = items.iter().position(|item| {
                serde_json::from_str::<Value>(item.get())
                    .ok()
                    .and_then(|value| value.get("name").and_then(Value::as_str).map(|n| names_match(n, name)))
                    .unwrap_or(false)
            });
            match (entry, position) {
                (Some(entry), Some(index)) => items[index] = raw_from_value(entry, 2)?,
                (Some(entry), None) => items.push(raw_from_value(entry, 2)?),
                (None, Some(index)) => {
                    items.remove(index);
                }
                (None, None) => return Ok(text.to_string()),
            }
            render_array(&items, 1)
        }
    };
    set_member(
        &mut root,
        container.key(),
        RawValue::from_string(rendered).map_err(|error| error.to_string())?,
    );
    Ok(format!("{}\n", render_object(&root.0, 0)))
}

/// Sets `enabledPlugins[plugin]` in Claude Code's settings.json text.
/// Returns the new text and the value it replaced.
fn write_plugin_enabled(text: &str, plugin: &str, enabled: Option<bool>) -> Result<(String, Option<bool>), String> {
    let mut root = parse_ordered(text)?;
    let mut plugins = match root.0.iter().find(|(key, _)| key == "enabledPlugins") {
        Some((_, raw)) => parse_ordered(raw.get())?,
        None => OrderedObject(Vec::new()),
    };
    let position = plugins.0.iter().position(|(key, _)| key == plugin);
    let previous = position.and_then(|index| serde_json::from_str::<bool>(plugins.0[index].1.get()).ok());
    match (enabled, position) {
        (Some(value), Some(index)) => plugins.0[index].1 = raw_from_value(&json!(value), 2)?,
        (Some(value), None) => plugins.0.push((plugin.to_string(), raw_from_value(&json!(value), 2)?)),
        (None, Some(index)) => {
            plugins.0.remove(index);
        }
        (None, None) => return Ok((text.to_string(), previous)),
    }
    let rendered = RawValue::from_string(render_object(&plugins.0, 1)).map_err(|error| error.to_string())?;
    set_member(&mut root, "enabledPlugins", rendered);
    Ok((format!("{}\n", render_object(&root.0, 0)), previous))
}

fn read_text(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

/// Rewrites a file through `edit`, retrying if another program changed it
/// between our read and our write (Claude Code rewrites ~/.claude.json often).
fn update_file(path: &Path, edit: impl Fn(&str) -> Result<String, String>) -> Result<(), String> {
    for _ in 0..3 {
        let before = read_text(path)?;
        let after = edit(&before)?;
        if after == before {
            return Ok(());
        }
        serde_json::from_str::<Value>(&after).map_err(|error| format!("Refusing to write invalid JSON: {error}"))?;
        if read_text(path)? != before {
            continue;
        }
        let temporary = path.with_extension(format!("connectors-{}.tmp", std::process::id()));
        fs::write(&temporary, after.as_bytes())
            .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
        replace_file_atomically(&temporary, path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Failed to replace {}: {error}", path.display())
        })?;
        return Ok(());
    }
    Err(format!("{} kept changing; try again", path.display()))
}

// ---------------------------------------------------------------------------
// Locations

struct Locations {
    home: PathBuf,
    local_app_data: PathBuf,
    /// Applied Claude Desktop profile and its display name, when Desktop is
    /// in third-party mode.
    desktop_profile: Option<(PathBuf, String)>,
}

impl Locations {
    fn resolve(home: PathBuf) -> Self {
        let local_app_data = agent_configuration_environment("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"));
        let desktop_profile = claude_desktop_config_paths(&home)
            .into_iter()
            .find(|path| path.file_name().is_some_and(|name| name == "_meta.json"))
            .and_then(|meta| applied_desktop_profile(&meta));
        Locations { home, local_app_data, desktop_profile }
    }

    fn code_config(&self) -> PathBuf {
        self.home.join(".claude.json")
    }

    fn code_settings(&self) -> PathBuf {
        self.home.join(".claude/settings.json")
    }

    fn target_file(&self, target: Target) -> Result<PathBuf, String> {
        match target {
            Target::Code => Ok(self.code_config()),
            Target::Desktop => self
                .desktop_profile
                .as_ref()
                .map(|(path, _)| path.clone())
                .ok_or_else(|| "Claude Desktop is not set up to use the proxy, so it has no profile to add connectors to".to_string()),
        }
    }

    fn connector_data(&self) -> PathBuf {
        self.local_app_data.join("TimAIHub/connectors")
    }
}

fn applied_desktop_profile(meta: &Path) -> Option<(PathBuf, String)> {
    let meta_value: Value = serde_json::from_str(&read_text(meta).ok()?).ok()?;
    let applied = meta_value.get("appliedId")?.as_str()?;
    if applied.is_empty() || applied.contains(['/', '\\', '.']) {
        return None;
    }
    let name = meta_value
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(applied)))
        .and_then(|entry| entry.get("name").and_then(Value::as_str))
        .unwrap_or(applied)
        .to_string();
    let profile = meta.parent()?.join(format!("{applied}.json"));
    profile.is_file().then_some((profile, name))
}

// ---------------------------------------------------------------------------
// Undo history

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChange {
    file: PathBuf,
    kind: HistoryKind,
    name: String,
    previous: Option<Value>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum HistoryKind {
    CodeServer,
    DesktopServer,
    CodePlugin,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    connector: String,
    at: String,
    changes: Vec<HistoryChange>,
}

fn history_path(locations: &Locations) -> PathBuf {
    locations.connector_data().join("history.json")
}

fn load_history(locations: &Locations) -> Vec<HistoryRecord> {
    read_text(&history_path(locations))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_history(locations: &Locations, history: &[HistoryRecord]) -> Result<(), String> {
    let path = history_path(locations);
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    let start = history.len().saturating_sub(HISTORY_LIMIT);
    let text = serde_json::to_string_pretty(&history[start..]).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("Failed to save connector history: {error}"))
}

/// Copies whole files aside before a change, as a last-resort recovery copy.
fn backup_files(locations: &Locations, files: &[PathBuf]) -> Result<(), String> {
    let root = locations.local_app_data.join("TimAIHub/backups");
    let directory = root.join(format!("connectors-{}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    fs::create_dir_all(&directory).map_err(|error| format!("Failed to create backup folder: {error}"))?;
    for (index, file) in files.iter().enumerate() {
        if file.is_file() {
            let name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
            fs::copy(file, directory.join(format!("{index}-{name}")))
                .map_err(|error| format!("Failed to back up {}: {error}", file.display()))?;
        }
    }
    let mut old: Vec<PathBuf> = fs::read_dir(&root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("connectors-")))
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    let excess = old.len().saturating_sub(FILE_BACKUP_LIMIT);
    for path in old.into_iter().take(excess) {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}

fn apply_history_change(change: &HistoryChange) -> Result<(), String> {
    match change.kind {
        HistoryKind::CodeServer | HistoryKind::DesktopServer => {
            let container = if change.kind == HistoryKind::CodeServer { Container::CodeServers } else { Container::DesktopServers };
            update_file(&change.file, |text| write_entry(text, container, &change.name, change.previous.as_ref()))
        }
        HistoryKind::CodePlugin => update_file(&change.file, |text| {
            write_plugin_enabled(text, &change.name, change.previous.as_ref().and_then(Value::as_bool)).map(|(text, _)| text)
        }),
    }
}

// ---------------------------------------------------------------------------
// Overview

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorTargetState {
    enabled: bool,
    access: Option<String>,
    /// Built into Claude Desktop rather than a program or address we run.
    built_in: bool,
    signed_in: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorOverviewItem {
    id: &'static str,
    access_levels: Vec<&'static str>,
    secret_names: Vec<&'static str>,
    secrets_configured: bool,
    secrets_desktop_only: bool,
    unavailable_reason: Option<&'static str>,
    claude_code: ConnectorTargetState,
    claude_desktop: ConnectorTargetState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorOverview {
    connectors: Vec<ConnectorOverviewItem>,
    desktop_profile: Option<String>,
    can_undo: bool,
    last_change: Option<String>,
}

fn google_signed_in(home: &Path) -> bool {
    fs::read_dir(home.join(".google_workspace_mcp/credentials"))
        .map(|entries| entries.filter_map(Result::ok).any(|entry| entry.path().extension().is_some_and(|ext| ext == "json")))
        .unwrap_or(false)
}

/// Whether Claude Code holds a sign-in for a remote connector. Reads presence
/// only; token values never leave this function.
fn code_oauth_signed_in(home: &Path, name: &str) -> bool {
    let Ok(text) = read_text(&home.join(".claude/.credentials.json")) else { return false };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return false };
    value
        .get("mcpOAuth")
        .and_then(Value::as_object)
        .is_some_and(|entries| {
            entries.iter().any(|(key, entry)| {
                key.split('|').next().is_some_and(|server| names_match(server, name))
                    && (entry.get("accessToken").is_some_and(|token| token.as_str().is_some_and(|t| !t.is_empty()))
                        || entry.get("refreshToken").is_some_and(|token| token.as_str().is_some_and(|t| !t.is_empty())))
            })
        })
}

fn target_state(id: ConnectorId, target: Target, entry: Option<&Value>, home: &Path) -> ConnectorTargetState {
    let built_in = entry.is_some_and(|entry| entry.get("server").is_some());
    let signed_in = entry.and_then(|entry| match id {
        ConnectorId::Google => Some(google_signed_in(home)),
        ConnectorId::Microsoft365 if target == Target::Code => Some(code_oauth_signed_in(home, id.entry_name(target))),
        ConnectorId::GitHub => Some(!secrets_from_entry(id, entry).is_empty()),
        _ => None,
    });
    ConnectorTargetState {
        enabled: entry.is_some(),
        access: entry.and_then(|entry| access_from_entry(id, entry)),
        built_in,
        signed_in,
    }
}

fn current_entry(locations: &Locations, id: ConnectorId, target: Target) -> Result<Option<Value>, String> {
    let Ok(file) = locations.target_file(target) else { return Ok(None) };
    read_entry(&read_text(&file)?, Container::for_target(target), id.entry_name(target))
}

fn existing_secrets(locations: &Locations, id: ConnectorId) -> Result<BTreeMap<String, String>, String> {
    let mut secrets = BTreeMap::new();
    for target in [Target::Desktop, Target::Code] {
        if let Some(entry) = current_entry(locations, id, target)? {
            secrets.extend(secrets_from_entry(id, &entry));
        }
    }
    Ok(secrets)
}

fn overview(locations: &Locations, runtimes: &Runtimes) -> Result<ConnectorOverview, String> {
    let mut connectors = Vec::new();
    for id in ConnectorId::ALL {
        let code = current_entry(locations, id, Target::Code)?;
        let desktop = current_entry(locations, id, Target::Desktop)?;
        let secrets = existing_secrets(locations, id)?;
        connectors.push(ConnectorOverviewItem {
            id: id.key(),
            access_levels: id.access_levels().to_vec(),
            secret_names: id.secret_names().to_vec(),
            secrets_configured: id.secret_names().iter().all(|name| secrets.contains_key(*name)),
            secrets_desktop_only: id.secrets_desktop_only(),
            unavailable_reason: runtimes.unavailable_reason(id),
            claude_code: target_state(id, Target::Code, code.as_ref(), &locations.home),
            claude_desktop: target_state(id, Target::Desktop, desktop.as_ref(), &locations.home),
        });
    }
    let history = load_history(locations);
    Ok(ConnectorOverview {
        connectors,
        desktop_profile: locations.desktop_profile.as_ref().map(|(_, name)| name.clone()),
        can_undo: !history.is_empty(),
        last_change: history.last().map(|record| record.connector.clone()),
    })
}

// ---------------------------------------------------------------------------
// Apply / undo

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorChangeRequest {
    id: String,
    claude_code: bool,
    claude_desktop: bool,
    access: Option<String>,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

fn apply_change(locations: &Locations, runtimes: &Runtimes, request: ConnectorChangeRequest) -> Result<(), String> {
    let id = ConnectorId::parse(&request.id)?;
    let current_access = [Target::Code, Target::Desktop]
        .into_iter()
        .find_map(|target| current_entry(locations, id, target).ok().flatten().and_then(|entry| access_from_entry(id, &entry)));
    let access = request
        .access
        .or(current_access)
        .unwrap_or_else(|| id.access_levels().first().copied().unwrap_or_default().to_string());
    if !id.access_levels().is_empty() && !id.access_levels().contains(&access.as_str()) {
        return Err(format!("Unknown access level: {access}"));
    }
    let mut secrets = existing_secrets(locations, id)?;
    secrets.extend(request.secrets.into_iter().filter(|(key, value)| {
        id.secret_names().contains(&key.as_str()) && !value.trim().is_empty()
    }));
    if id == ConnectorId::Microsoft365 && request.claude_desktop {
        check_microsoft_ids(&secrets)?;
    }

    // Build everything first so a missing secret or program changes nothing.
    let mut plan: Vec<(Target, PathBuf, Option<Value>, Option<Value>)> = Vec::new();
    for (target, wanted) in [(Target::Code, request.claude_code), (Target::Desktop, request.claude_desktop)] {
        let previous = current_entry(locations, id, target)?;
        if !wanted && previous.is_none() {
            continue;
        }
        let file = locations.target_file(target)?;
        let next = if wanted {
            for name in id.secrets_for(target) {
                if !secrets.contains_key(*name) {
                    return Err(format!("missing_secret:{name}"));
                }
            }
            Some(build_entry(id, target, &access, &secrets, runtimes)?)
        } else {
            None
        };
        if next != previous {
            plan.push((target, file, previous, next));
        }
    }
    let disable_github_plugin = id == ConnectorId::GitHub && request.claude_code;
    if plan.is_empty() && !disable_github_plugin {
        return Ok(());
    }

    let mut files: Vec<PathBuf> = plan.iter().map(|(_, file, _, _)| file.clone()).collect();
    if disable_github_plugin {
        files.push(locations.code_settings());
    }
    backup_files(locations, &files)?;

    let mut changes = Vec::new();
    for (target, file, previous, next) in plan {
        update_file(&file, |text| write_entry(text, Container::for_target(target), id.entry_name(target), next.as_ref()))?;
        changes.push(HistoryChange {
            file,
            kind: if target == Target::Code { HistoryKind::CodeServer } else { HistoryKind::DesktopServer },
            name: id.entry_name(target).to_string(),
            previous,
        });
    }
    // The official GitHub plugin needs a token variable that is not set, so it
    // fails on every start; our entry replaces it.
    if disable_github_plugin {
        let settings = locations.code_settings();
        let text = read_text(&settings)?;
        if !text.trim().is_empty() {
            let (_, previous) = write_plugin_enabled(&text, GITHUB_PLUGIN_ID, Some(false))?;
            if previous == Some(true) {
                update_file(&settings, |text| write_plugin_enabled(text, GITHUB_PLUGIN_ID, Some(false)).map(|(text, _)| text))?;
                changes.push(HistoryChange {
                    file: settings,
                    kind: HistoryKind::CodePlugin,
                    name: GITHUB_PLUGIN_ID.to_string(),
                    previous: Some(json!(true)),
                });
            }
        }
    }
    if changes.is_empty() {
        return Ok(());
    }
    let mut history = load_history(locations);
    history.push(HistoryRecord { connector: id.key().to_string(), at: chrono::Local::now().to_rfc3339(), changes });
    save_history(locations, &history)
}

fn undo_last(locations: &Locations) -> Result<Option<String>, String> {
    let mut history = load_history(locations);
    let Some(record) = history.pop() else { return Ok(None) };
    let files: Vec<PathBuf> = record.changes.iter().map(|change| change.file.clone()).collect();
    backup_files(locations, &files)?;
    for change in record.changes.iter().rev() {
        apply_history_change(change)?;
    }
    save_history(locations, &history)?;
    Ok(Some(record.connector))
}

// ---------------------------------------------------------------------------
// Connection test

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorTestResult {
    /// "ok", "needsSignIn", "builtIn" or "failed".
    status: &'static str,
    tool_count: Option<usize>,
    message: Option<String>,
}

fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

fn initialize_request() -> String {
    rpc(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "tims-ai-hub", "version": env!("CARGO_PKG_VERSION") },
        }),
    )
}

fn tool_count(response: &Value) -> Option<usize> {
    response.pointer("/result/tools").and_then(Value::as_array).map(Vec::len)
}

/// Keeps only the last lines of a server's error output, for display.
fn tail_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn test_stdio(entry: &Value) -> ConnectorTestResult {
    let failed = |message: String| ConnectorTestResult { status: "failed", tool_count: None, message: Some(message) };
    let Some(command) = entry.get("command").and_then(Value::as_str) else {
        return failed("The entry has no command".to_string());
    };
    let args: Vec<String> = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(|arg| arg.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let mut process = Command::new(command);
    process.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = user_home() {
        process.env("PATH", child_path(&home));
    }
    if let Some(env) = entry.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                process.env(key, value);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return failed(format!("Could not start {command}: {error}")),
    };
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (sender, receiver) = mpsc::channel::<Value>();
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
    }
    let error_output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let sink = error_output.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut buffer) = sink.lock() {
                    if buffer.len() < 64 * 1024 {
                        buffer.push_str(&line);
                        buffer.push('\n');
                    }
                }
            }
        });
    }
    let mut send = |line: String| -> bool {
        stdin.as_mut().is_some_and(|stdin| writeln!(stdin, "{line}").and_then(|_| stdin.flush()).is_ok())
    };
    let deadline = Instant::now() + STDIO_TEST_TIMEOUT;
    let wait_for = |id: u64| -> Option<Value> {
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            match receiver.recv_timeout(remaining) {
                Ok(message) if message.get("id").and_then(Value::as_u64) == Some(id) => return Some(message),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    };
    let result = if !send(initialize_request()) {
        failed("Could not talk to the connector".to_string())
    } else {
        match wait_for(1) {
            None => failed("The connector did not start in time".to_string()),
            Some(response) if response.get("error").is_some() => failed(format!("Start-up error: {}", response["error"])),
            Some(_) => {
                send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string());
                send(rpc(2, "tools/list", json!({})));
                match wait_for(2).as_ref().and_then(tool_count) {
                    Some(count) => ConnectorTestResult { status: "ok", tool_count: Some(count), message: None },
                    None => failed("The connector started but did not list its tools".to_string()),
                }
            }
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    if result.status == "failed" {
        let detail = error_output.lock().map(|text| tail_lines(&text, 6)).unwrap_or_default();
        if !detail.is_empty() {
            return failed(format!("{}\n{}", result.message.unwrap_or_default(), crate::truncate_for_error(&detail)));
        }
    }
    result
}

/// Reads a JSON-RPC message from either a JSON or an event-stream body.
fn http_message(body: &str) -> Option<Value> {
    serde_json::from_str(body).ok().or_else(|| {
        body.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|value| value.get("id").is_some())
    })
}

async fn test_http(entry: &Value) -> ConnectorTestResult {
    let failed = |message: String| ConnectorTestResult { status: "failed", tool_count: None, message: Some(message) };
    let Some(url) = entry.get("url").and_then(Value::as_str) else {
        return failed("The entry has no address".to_string());
    };
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
        Ok(client) => client,
        Err(error) => return failed(error.to_string()),
    };
    let headers: Vec<(String, String)> = entry
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| headers.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    let post = |body: String, session: Option<String>| {
        let mut request = client
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body);
        for (key, value) in &headers {
            request = request.header(key, value);
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        request.send()
    };
    let response = match post(initialize_request(), None).await {
        Ok(response) => response,
        Err(error) => return failed(format!("Could not reach the connector: {error}")),
    };
    if response.status().as_u16() == 401 {
        return ConnectorTestResult { status: "needsSignIn", tool_count: None, message: None };
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return failed(format!("The connector answered {status}: {}", crate::truncate_for_error(&body)));
    }
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let _ = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(), session.clone()).await;
    let count = match post(rpc(2, "tools/list", json!({})), session).await {
        Ok(response) => http_message(&response.text().await.unwrap_or_default()).as_ref().and_then(tool_count),
        Err(_) => None,
    };
    ConnectorTestResult { status: "ok", tool_count: count, message: None }
}

// ---------------------------------------------------------------------------
// Test with AI
//
// Runs one Claude Code prompt in the background that must call the connector
// and answer with a single RESULT line. The run gets no built-in tools, refuses
// anything not pre-approved (`dontAsk`), and pre-approves only named read-only
// tools, so it cannot send, edit or delete regardless of the user's own
// permission mode.

const AI_TEST_TIMEOUT: Duration = Duration::from_secs(240);
const AI_TEST_MESSAGE_LIMIT: usize = 300;

/// The account the Google connector signed in with: its credential file is
/// named after the address.
fn google_account(home: &Path) -> Option<String> {
    let mut accounts: Vec<String> = fs::read_dir(home.join(".google_workspace_mcp/credentials"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string))
        .filter(|stem| stem.contains('@'))
        .collect();
    accounts.sort();
    accounts.into_iter().next()
}

/// The entry's actual key in `~/.claude.json`; hand-made entries may differ in
/// case from the name this app writes, and tool names are built from the key.
fn code_entry_key(locations: &Locations, id: ConnectorId) -> Option<String> {
    let value: Value = serde_json::from_str(&read_text(&locations.code_config()).ok()?).ok()?;
    let wanted = id.entry_name(Target::Code);
    value
        .get("mcpServers")?
        .as_object()?
        .keys()
        .find(|key| names_match(key, wanted))
        .cloned()
}

const AI_TEST_RESULT_RULES: &str = "Do not include any personal details, message contents, titles, names or addresses in your answer. \
Do not create, send, change or delete anything. \
Finish with exactly one line in one of these forms:\n\
RESULT: PASS - <a few words, for example \"3 events today\">\n\
RESULT: SIGNIN - <a few words>   (when the tools say a sign-in or authorisation is needed)\n\
RESULT: FAIL - <a few words on what went wrong>";

/// Tools the AI test may use and the question it asks. `None` for connectors
/// whose test would act on the computer or spend paid credits.
fn ai_test_plan(id: ConnectorId, server: &str, google_email: Option<&str>, today: &str) -> Option<(Vec<String>, String)> {
    let tool = |name: &str| format!("mcp__{server}__{name}");
    let (tools, task) = match id {
        ConnectorId::Google => (
            vec![tool("list_calendars"), tool("get_events")],
            format!(
                "Use the Google Calendar tools with user_google_email={} to count the events on the primary calendar for {today} (local time).",
                google_email.unwrap_or("the signed-in account")
            ),
        ),
        ConnectorId::GitHub => (
            vec![tool("get_me")],
            "Use the GitHub get_me tool to confirm which account is connected, then report only how many public repositories it has.".to_string(),
        ),
        // Anthropic's Microsoft 365 connector only offers read and search
        // tools, so the whole server is allowed; its tool names are not
        // listed until after sign-in.
        ConnectorId::Microsoft365 => (
            vec![format!("mcp__{server}")],
            format!("Use the Microsoft 365 tools to count the Outlook emails received on {today}."),
        ),
        ConnectorId::Playwright | ConnectorId::Windows | ConnectorId::Firecrawl => return None,
    };
    Some((tools, format!("{task}\n\n{AI_TEST_RESULT_RULES}")))
}

/// Turns the run's output into a test result. Only the RESULT line is shown.
fn parse_ai_test_output(output: &str, exit_ok: bool) -> ConnectorTestResult {
    let shorten = |text: &str| {
        let text = text.trim().trim_start_matches(['-', ':', ' ']).trim();
        let mut short: String = text.chars().take(AI_TEST_MESSAGE_LIMIT).collect();
        if text.chars().count() > AI_TEST_MESSAGE_LIMIT {
            short.push('…');
        }
        short
    };
    let result_line = output
        .lines()
        .rev()
        .map(|line| line.trim().trim_matches('*').trim())
        .find_map(|line| line.strip_prefix("RESULT:"));
    let Some(rest) = result_line else {
        let detail = tail_lines(output, 3);
        let message = if detail.is_empty() {
            if exit_ok { "Claude did not give a result".to_string() } else { "Claude Code did not run".to_string() }
        } else {
            shorten(&detail)
        };
        return ConnectorTestResult { status: "failed", tool_count: None, message: Some(message) };
    };
    let rest = rest.trim();
    let (status, detail) = if let Some(detail) = rest.strip_prefix("PASS") {
        ("ok", detail)
    } else if let Some(detail) = rest.strip_prefix("SIGNIN") {
        ("needsSignIn", detail)
    } else {
        ("failed", rest.strip_prefix("FAIL").unwrap_or(rest))
    };
    let detail = shorten(detail);
    ConnectorTestResult { status, tool_count: None, message: Some(detail).filter(|text| !text.is_empty()) }
}

fn find_claude_code(home: &Path) -> Option<PathBuf> {
    [home.join(".local/bin/claude.exe"), home.join(".local/bin/claude")]
        .into_iter()
        .chain(find_on_path("claude"))
        .find(|path| path.is_file())
}

fn ai_test_args(tools: &[String], prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        prompt.to_string(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--tools".to_string(),
        String::new(),
        "--allowedTools".to_string(),
        tools.join(","),
        "--model".to_string(),
        "haiku".to_string(),
        "--no-session-persistence".to_string(),
        "--output-format".to_string(),
        "text".to_string(),
    ]
}

fn run_ai_test(claude: &Path, home: &Path, args: &[String]) -> ConnectorTestResult {
    let mut process = Command::new(claude);
    process.args(args).current_dir(home).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A parent Claude session's variables would make this run expect that
    // session to sign it in; the user's own Claude Code settings apply instead.
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key.starts_with("CLAUDE") || key.starts_with("ANTHROPIC") || key.starts_with("MCP_") {
            process.env_remove(key.as_ref());
        }
    }
    process.env("MCP_CONNECTION_NONBLOCKING", "false");
    process.env("PATH", child_path(home));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ConnectorTestResult { status: "failed", tool_count: None, message: Some(format!("Could not start Claude Code: {error}")) }
        }
    };
    let collect = |stream: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stream) = stream {
                let _ = std::io::Read::read_to_string(&mut stream, &mut text);
            }
            text
        })
    };
    let stdout = collect(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let stderr = collect(child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let deadline = Instant::now() + AI_TEST_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = stdout.join().unwrap_or_default();
    let errors = stderr.join().unwrap_or_default();
    match status {
        None => ConnectorTestResult { status: "failed", tool_count: None, message: Some("Claude did not finish within 4 minutes".to_string()) },
        Some(status) => {
            let combined = if output.contains("RESULT:") { output } else { format!("{output}\n{errors}") };
            parse_ai_test_output(&combined, status.success())
        }
    }
}

/// The Claude Code entry a connector would get, built from its Claude Desktop
/// settings, for a connector that is only on in Claude Desktop.
fn temporary_code_entry(locations: &Locations, id: ConnectorId) -> Result<Option<Value>, String> {
    let Some(desktop) = current_entry(locations, id, Target::Desktop)? else { return Ok(None) };
    let access = access_from_entry(id, &desktop).unwrap_or_else(|| "read".to_string());
    let secrets = existing_secrets(locations, id)?;
    let runtimes = Runtimes::detect(&locations.home, &locations.local_app_data);
    build_entry(id, Target::Code, &access, &secrets, &runtimes).map(Some)
}

/// Deletes the one-off connector file when the test ends; it may hold the
/// connector's login settings.
struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn ai_test(locations: &Locations, id: ConnectorId, today: &str) -> ConnectorTestResult {
    let failed = |message: &str| ConnectorTestResult { status: "failed", tool_count: None, message: Some(message.to_string()) };
    // A connector that is only on in Claude Desktop is tested with a one-off
    // copy handed to this run alone; the user's Claude Code settings are not changed.
    let (server, temporary) = match code_entry_key(locations, id) {
        Some(server) => (server, None),
        None => match temporary_code_entry(locations, id) {
            Ok(Some(entry)) => (id.entry_name(Target::Code).to_string(), Some(entry)),
            Ok(None) => return failed("Turn this connector on for Claude Code or Claude Desktop first"),
            Err(error) => return failed(&error),
        },
    };
    // Without a saved sign-in the run could only hand back a link that stops
    // working when it exits, so say so without spending a request. Claude
    // Desktop's Microsoft sign-in is held by Claude Desktop and cannot be reused.
    let signed_in = match id {
        ConnectorId::Google => google_signed_in(&locations.home),
        ConnectorId::Microsoft365 => code_oauth_signed_in(&locations.home, &server),
        _ => true,
    };
    if !signed_in {
        let message = (id == ConnectorId::Microsoft365 && temporary.is_some()).then(|| "desktopOnly".to_string());
        return ConnectorTestResult { status: "needsSignIn", tool_count: None, message };
    }
    let email = google_account(&locations.home);
    let Some((tools, prompt)) = ai_test_plan(id, &server, email.as_deref(), today) else {
        return failed("Test with AI is not available for this connector");
    };
    let Some(claude) = find_claude_code(&locations.home) else {
        return failed("Claude Code is not installed");
    };
    let mut args = ai_test_args(&tools, &prompt);
    let _cleanup = match temporary {
        Some(entry) => {
            let path = locations.connector_data().join(format!("ai-test-{}.json", std::process::id()));
            let config = json!({ "mcpServers": { server.clone(): entry } });
            if let Err(error) = fs::create_dir_all(locations.connector_data()).and_then(|_| fs::write(&path, config.to_string())) {
                return failed(&format!("Could not prepare the test: {error}"));
            }
            args.extend(["--mcp-config".to_string(), path.to_string_lossy().to_string(), "--strict-mcp-config".to_string()]);
            Some(TemporaryFile(path))
        }
        None => None,
    };
    run_ai_test(&claude, &locations.home, &args)
}

// ---------------------------------------------------------------------------
// Commands

fn locations_for(app: &tauri::AppHandle) -> Result<Locations, String> {
    use tauri::Manager;
    let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
    Ok(Locations::resolve(home))
}

#[tauri::command]
pub(crate) async fn get_connector_overview(app: tauri::AppHandle) -> Result<ConnectorOverview, String> {
    let locations = locations_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let runtimes = Runtimes::detect(&locations.home, &locations.local_app_data);
        overview(&locations, &runtimes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn apply_connector_change(
    app: tauri::AppHandle,
    request: ConnectorChangeRequest,
) -> Result<ConnectorOverview, String> {
    let locations = locations_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let runtimes = Runtimes::detect(&locations.home, &locations.local_app_data);
        apply_change(&locations, &runtimes, request)?;
        overview(&locations, &runtimes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn undo_connector_change(app: tauri::AppHandle) -> Result<ConnectorOverview, String> {
    let locations = locations_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let runtimes = Runtimes::detect(&locations.home, &locations.local_app_data);
        undo_last(&locations)?;
        overview(&locations, &runtimes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn test_connector(app: tauri::AppHandle, id: String, target: String) -> Result<ConnectorTestResult, String> {
    let locations = locations_for(&app)?;
    let id = ConnectorId::parse(&id)?;
    let target: Target = serde_json::from_value(json!(target)).map_err(|_| format!("Unknown target: {target}"))?;
    let entry = current_entry(&locations, id, target)?.ok_or("This connector is not turned on there")?;
    if entry.get("server").is_some() {
        return Ok(ConnectorTestResult { status: "builtIn", tool_count: None, message: None });
    }
    let hidden = hidden_values(&entry);
    let result = if entry.get("url").is_some() {
        test_http(&entry).await
    } else {
        tauri::async_runtime::spawn_blocking(move || test_stdio(&entry))
            .await
            .map_err(|error| error.to_string())?
    };
    Ok(redact_result(result, &hidden))
}

/// `today` is the page's local date (YYYY-MM-DD); it goes into the prompt, so
/// anything else is rejected.
#[tauri::command]
pub(crate) async fn ai_test_connector(app: tauri::AppHandle, id: String, today: String) -> Result<ConnectorTestResult, String> {
    let locations = locations_for(&app)?;
    let id = ConnectorId::parse(&id)?;
    if !valid_date(&today) {
        return Err(format!("Invalid date: {today}"));
    }
    let mut hidden = Vec::new();
    for target in [Target::Code, Target::Desktop] {
        if let Some(entry) = current_entry(&locations, id, target)? {
            hidden.extend(hidden_values(&entry));
        }
    }
    let result = tauri::async_runtime::spawn_blocking(move || ai_test(&locations, id, &today))
        .await
        .map_err(|error| error.to_string())?;
    Ok(redact_result(result, &hidden))
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| if index == 4 || index == 7 { *byte == b'-' } else { byte.is_ascii_digit() })
}

/// Values a connector entry carries in its environment or headers. A failing
/// program may echo them in its error output, so they are hidden before display.
fn hidden_values(entry: &Value) -> Vec<String> {
    let mut values = Vec::new();
    for key in ["env", "headers"] {
        if let Some(map) = entry.get(key).and_then(Value::as_object) {
            for value in map.values().filter_map(Value::as_str) {
                let value = value.trim();
                values.push(value.to_string());
                if let Some(token) = value.strip_prefix("Bearer ") {
                    values.push(token.trim().to_string());
                }
            }
        }
    }
    values.retain(|value| value.len() >= 6);
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values
}

fn redact_result(mut result: ConnectorTestResult, hidden: &[String]) -> ConnectorTestResult {
    if let Some(message) = result.message.as_mut() {
        for value in hidden {
            *message = message.replace(value.as_str(), "[hidden]");
        }
    }
    result
}

#[cfg(test)]
mod tests;
