//! When each connector was last used, from Claude Code's own conversation logs
//! (`~/.claude/projects/*/*.jsonl`). Connectors talk to the apps directly, never
//! through the hub, so this is the only record there is.
//!
//! Only lines that mention an `mcp__` tool are parsed, and from those only the
//! tool's name and the line's timestamp are kept. No message text is read out,
//! stored or sent anywhere. Claude Desktop keeps no comparable log, so its use
//! doesn't show here.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::Manager;

/// Logs untouched for longer than this can't hold a newer use, so they aren't opened.
const LOOK_BACK: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// One very long line (a pasted file, say) is skipped rather than held in memory.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// The MCP server name in a Claude Code tool name: `mcp__github__search_code` → `github`.
fn server_of(tool: &str) -> Option<&str> {
    tool.strip_prefix("mcp__")?.split("__").next().filter(|server| !server.is_empty())
}

/// Folds one log line into `latest` (connector key → newest ISO timestamp). ISO 8601 UTC sorts as text.
fn fold_line(line: &str, latest: &mut BTreeMap<String, String>) {
    if !line.contains("\"mcp__") {
        return;
    }
    let Ok(entry) = serde_json::from_str::<Value>(line) else { return };
    let Some(at) = entry.get("timestamp").and_then(Value::as_str) else { return };
    let Some(content) = entry.pointer("/message/content").and_then(Value::as_array) else { return };
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(key) = item.get("name").and_then(Value::as_str).and_then(server_of).and_then(crate::connectors::connector_for_server) else { continue };
        let newer = latest.get(key).map_or(true, |seen| at > seen.as_str());
        if newer {
            latest.insert(key.to_string(), at.to_string());
        }
    }
}

fn fold_file(path: &Path, latest: &mut BTreeMap<String, String>) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(read) if read > MAX_LINE_BYTES => continue,
            Ok(_) => fold_line(&line, latest),
        }
    }
}

fn recent_logs(projects: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Ok(dirs) = std::fs::read_dir(projects) else { return Vec::new() };
    dirs.flatten()
        .filter_map(|dir| std::fs::read_dir(dir.path()).ok())
        .flat_map(|files| files.flatten())
        .filter(|file| file.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter(|file| file.metadata().and_then(|m| m.modified()).is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() <= LOOK_BACK))
        .map(|file| file.path())
        .collect()
}

pub(crate) fn last_used_in(projects: &Path, now: SystemTime) -> BTreeMap<String, String> {
    let mut latest = BTreeMap::new();
    for path in recent_logs(projects, now) {
        fold_file(&path, &mut latest);
    }
    latest
}

/// Connector key → when Claude Code last called one of its tools (ISO 8601). Connectors never used are absent.
#[tauri::command]
pub(crate) async fn connector_last_used(app: tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
    let projects = home.join(".claude").join("projects");
    tauri::async_runtime::spawn_blocking(move || last_used_in(&projects, SystemTime::now()))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_line(at: &str, tool: &str) -> String {
        format!(r#"{{"type":"assistant","timestamp":"{at}","message":{{"content":[{{"type":"text","text":"private words"}},{{"type":"tool_use","name":"{tool}","input":{{"q":"secret query"}}}}]}}}}"#)
    }

    #[test]
    fn keeps_the_newest_use_per_connector_and_nothing_else() {
        let mut latest = BTreeMap::new();
        fold_line(&tool_line("2026-10-20T10:00:00.000Z", "mcp__github__search_code"), &mut latest);
        fold_line(&tool_line("2026-10-25T09:00:00.000Z", "mcp__github__get_me"), &mut latest);
        fold_line(&tool_line("2026-10-22T09:00:00.000Z", "mcp__github__list_issues"), &mut latest);
        // Claude Desktop's capitalised names and Claude Code's lower-case ones are the same connector.
        fold_line(&tool_line("2026-10-24T08:00:00.000Z", "mcp__Codebase-Memory__search_graph"), &mut latest);
        // Not a hub connector, not an MCP tool, not a tool call at all.
        fold_line(&tool_line("2026-10-26T08:00:00.000Z", "mcp__plugin_chrome-devtools-mcp_chrome-devtools__click"), &mut latest);
        fold_line(&tool_line("2026-10-26T08:00:00.000Z", "Bash"), &mut latest);
        fold_line(r#"{"timestamp":"2026-10-26T08:00:00.000Z","message":{"content":"talked about mcp__github__ only"}}"#, &mut latest);
        fold_line("not json \"mcp__github__x", &mut latest);
        assert_eq!(latest, BTreeMap::from([
            ("codegraph".to_string(), "2026-10-24T08:00:00.000Z".to_string()),
            ("github".to_string(), "2026-10-25T09:00:00.000Z".to_string()),
        ]));
        assert!(!format!("{latest:?}").contains("private") && !format!("{latest:?}").contains("secret"), "only names and times are kept");
    }

    #[test]
    fn reads_recent_logs_and_skips_old_ones() {
        let root = std::env::temp_dir().join(format!("hub-connector-usage-{}", std::process::id()));
        let project = root.join("C--work");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.jsonl"), tool_line("2026-10-25T09:00:00.000Z", "mcp__markitdown__convert_to_markdown") + "\n").unwrap();
        std::fs::write(project.join("notes.txt"), tool_line("2026-10-26T09:00:00.000Z", "mcp__github__get_me")).unwrap();
        let found = last_used_in(&root, SystemTime::now());
        assert_eq!(found.get("markitdown").map(String::as_str), Some("2026-10-25T09:00:00.000Z"));
        assert!(!found.contains_key("github"), "only .jsonl logs are read");
        // Seen from far enough in the future, the same log is too old to open.
        assert!(last_used_in(&root, SystemTime::now() + LOOK_BACK + Duration::from_secs(60)).is_empty());
        assert!(last_used_in(&root.join("missing"), SystemTime::now()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
