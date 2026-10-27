//! Which app sent a request, from its headers. Shared by Secret Guard and App Routing (included with `#[path]`),
//! so both name apps the same way the hub does.

use serde_json::Value;

/// The User-Agent, capped. Kept whole because Claude Desktop identifies itself
/// as `claude-cli/… (claude-desktop-3p)`: the app name isn't always first.
pub fn client_name(headers: &Value) -> String {
    let ua = headers
        .as_object()
        .and_then(|h| h.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")))
        .and_then(|(_, v)| v.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).or(v.as_str()))
        .unwrap_or("");
    ua.chars().take(120).collect()
}

/// The hub's id for the app that sent a request, from its User-Agent; `other` when it isn't one the hub knows.
/// Claude Desktop sends `claude-cli/… (claude-desktop-3p)`, so it is checked before Claude Code.
pub fn client_app(user_agent: &str) -> &'static str {
    let ua = user_agent.to_ascii_lowercase();
    const APPS: &[(&str, &str)] = &[
        ("claude-desktop", "claude-desktop"), ("claude-cli", "claude-code"), ("claude-code", "claude-code"),
        ("opencode", "opencode"), ("openclaw", "openclaw"), ("codex", "codex"), ("hermes", "hermes"),
        ("kimi", "kimi-code"), ("grok", "grok-build"), ("antigravity", "antigravity-cli"), ("zcode", "zcode"),
        ("workbuddy", "workbuddy"), ("deepseek", "deepseek-harness"),
    ];
    APPS.iter().find(|(needle, _)| ua.contains(needle)).map_or("other", |(_, app)| app)
}
