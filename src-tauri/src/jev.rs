//! Read-only view of Jev, the Claude Code hooks in `~/.claude/jev`.
//!
//! Reads what Jev already writes: its nightly self-test and replay results, the
//! "did it pay off" report (`state/jev-report.json`) and its decision log. The
//! only action is refreshing that report, which runs Jev's own report script.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const REPORT_DAYS: u32 = 7;
const INTERVENTION_LIMIT: usize = 30;
/// Log lines read from the end of the newest files; plenty for a week of interventions.
const LOG_TAIL_LINES: usize = 40_000;

fn jev_dir(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
    Ok((home.join(".claude/jev"), home.join(".claude/settings.json")))
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok())
}

/// One Claude Code hook that runs a Jev script.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JevHook {
    event: String,
    script: String,
}

/// The Jev scripts registered as Claude Code hooks, and the Python they run with.
fn registered_hooks(settings: &Value) -> (Vec<JevHook>, Option<String>) {
    let mut hooks = Vec::new();
    let mut python = None;
    let mut seen = BTreeSet::new();
    let Some(events) = settings.get("hooks").and_then(Value::as_object) else {
        return (hooks, python);
    };
    for (event, groups) in events {
        for group in groups.as_array().into_iter().flatten() {
            for hook in group.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                let Some(command) = hook.get("command").and_then(Value::as_str) else { continue };
                let normalized = command.replace('\\', "/");
                let Some(at) = normalized.find("/.claude/jev/") else { continue };
                let script = normalized[at + "/.claude/jev/".len()..]
                    .split(|c: char| c == '"' || c.is_whitespace())
                    .next()
                    .unwrap_or_default()
                    .to_string();
                if python.is_none() {
                    python = interpreter(command);
                }
                if !script.is_empty() && seen.insert((event.clone(), script.clone())) {
                    hooks.push(JevHook { event: event.clone(), script });
                }
            }
        }
    }
    (hooks, python)
}

/// The program at the start of a hook command: `"C:/…/python.exe" script.py` → `C:/…/python.exe`.
fn interpreter(command: &str) -> Option<String> {
    let command = command.trim();
    let program = if let Some(rest) = command.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        command.split_whitespace().next()?
    };
    program.to_ascii_lowercase().contains("python").then(|| program.to_string())
}

/// A time Jev stepped into a session, as opposed to the many checks that let work through.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JevIntervention {
    ts: String,
    /// sentBack | blocked | asked | guarded | loopStopped
    kind: &'static str,
    /// What it was about, in Jev's own words when it gave any.
    detail: String,
    project: Option<String>,
}

fn kinds_text(record: &Value) -> String {
    match record.get("kinds") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn number(record: &Value, key: &str) -> i64 {
    match record.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

/// Picks out the log records where Jev acted. Shadow-mode records only measured, so they're left out.
fn intervention(record: &Value) -> Option<JevIntervention> {
    let hook = record.get("hook")?.as_str()?;
    let event = record.get("event")?.as_str()?;
    let mode = record.get("mode").and_then(Value::as_str).unwrap_or("");
    let (kind, detail) = match (hook, event) {
        ("stop_verifier", "completion_verdict") if mode == "block" && record.get("would").and_then(Value::as_str) == Some("flag") => {
            ("sentBack", String::new())
        }
        ("rule_enforcer" | "remote_enforcer", "verdict") => {
            let what = if hook == "remote_enforcer" { "remote patch" } else { "edit" };
            if number(record, "deny") > 0 {
                ("blocked", what.to_string())
            } else if number(record, "ask") > 0 {
                ("asked", what.to_string())
            } else {
                return None;
            }
        }
        ("rule_enforcer" | "remote_enforcer", "deterministic_block") => ("blocked", kinds_text(record)),
        ("global_guard", "guard") | ("browser_guard", "browser_guard") => ("guarded", kinds_text(record)),
        ("command_risk", "command_risk") if mode != "shadow" && record.get("verdict").and_then(Value::as_str) == Some("ask") => {
            ("asked", "command".to_string())
        }
        ("compact_resume", "compaction_loop") => ("loopStopped", number(record, "count").to_string()),
        _ => return None,
    };
    Some(JevIntervention {
        ts: record.get("ts").and_then(Value::as_str).unwrap_or_default().to_string(),
        kind,
        detail,
        project: record.get("project").and_then(Value::as_str).map(str::to_string),
    })
}

/// The newest interventions since `cutoff` (an ISO timestamp), newest first.
fn recent_interventions(lines: &[String], cutoff: &str, limit: usize) -> Vec<JevIntervention> {
    let mut found: Vec<JevIntervention> = lines
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record.get("ts").and_then(Value::as_str).is_some_and(|ts| ts >= cutoff))
        .filter_map(|record| intervention(&record))
        .collect();
    found.sort_by(|a, b| b.ts.cmp(&a.ts));
    found.truncate(limit);
    found
}

fn tail_log_lines(logs: &Path) -> Vec<String> {
    let mut files: Vec<PathBuf> = fs::read_dir(logs)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("decisions-") && name.ends_with(".jsonl"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut lines = Vec::new();
    for file in files.iter().rev().take(2).rev() {
        if let Ok(text) = fs::read_to_string(file) {
            lines.extend(text.lines().map(str::to_string));
        }
    }
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines.split_off(start)
}

/// The parts of Jev's report the page shows; the rest (charts, per-compaction detail) stays in the full report.
fn report_summary(report: &Value) -> Value {
    let keep = ["generated", "days", "verdicts", "answers", "cost", "spend_usd", "ms_per_check", "alerts"];
    let mut summary = serde_json::Map::new();
    for key in keep {
        if let Some(value) = report.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(summary)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JevOverview {
    installed: bool,
    hooks: Vec<JevHook>,
    selftest: Option<Value>,
    replay: Option<Value>,
    report: Option<Value>,
    report_path: Option<String>,
    interventions: Vec<JevIntervention>,
}

/// Reads a few megabytes of log, so it runs off the main thread.
#[tauri::command]
pub(crate) async fn jev_overview(app: tauri::AppHandle) -> Result<JevOverview, String> {
    let (dir, settings_path) = jev_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_overview(&dir, &settings_path))
        .await
        .map_err(|error| error.to_string())
}

fn read_overview(dir: &Path, settings_path: &Path) -> JevOverview {
    let installed = dir.join("jev.py").is_file();
    let (hooks, _) = read_json(settings_path).map(|settings| registered_hooks(&settings)).unwrap_or_default();
    let report_file = dir.join("state/jev-report.html");
    let cutoff = (chrono::Local::now() - chrono::Duration::days(i64::from(REPORT_DAYS)))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    JevOverview {
        installed,
        hooks,
        selftest: read_json(&dir.join("state/selftest.json")),
        replay: read_json(&dir.join("state/replay.json")),
        report: read_json(&dir.join("state/jev-report.json")).map(|report| report_summary(&report)),
        report_path: report_file.is_file().then(|| report_file.to_string_lossy().to_string()),
        interventions: if installed { recent_interventions(&tail_log_lines(&dir.join("logs")), &cutoff, INTERVENTION_LIMIT) } else { Vec::new() },
    }
}

/// Reruns Jev's own report script, which rewrites `state/jev-report.json` and the full HTML report.
#[tauri::command]
pub(crate) async fn refresh_jev_report(app: tauri::AppHandle) -> Result<(), String> {
    let (dir, settings_path) = jev_dir(&app)?;
    let script = dir.join("jev_report.py");
    if !script.is_file() {
        return Err("Jev's report script isn't installed".to_string());
    }
    let python = read_json(&settings_path)
        .and_then(|settings| registered_hooks(&settings).1)
        .unwrap_or_else(|| "python".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = std::process::Command::new(&python);
        command.arg(&script).arg(REPORT_DAYS.to_string()).arg("--html").current_dir(&dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().map_err(|error| format!("Couldn't run Jev's report: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Jev's report failed: {}", stderr.lines().last().unwrap_or("no details")))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens Jev's full HTML report in the default browser.
#[tauri::command]
pub(crate) fn open_jev_report(app: tauri::AppHandle) -> Result<(), String> {
    let (dir, _) = jev_dir(&app)?;
    let report = dir.join("state/jev-report.html");
    if !report.is_file() {
        return Err("Jev's full report hasn't been written yet".to_string());
    }
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(&report);
    command.spawn().map(|_| ()).map_err(|error| format!("Couldn't open Jev's report: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_jev_hooks_and_their_python() {
        let settings = json!({ "hooks": {
            "Stop": [{ "hooks": [{ "type": "command", "command": "\"C:/Py/python.exe\" C:/Users/me/.claude/jev/stop_verifier.py" }] }],
            "PreToolUse": [
                { "matcher": "Edit", "hooks": [{ "command": "\"C:/Py/python.exe\" C:\\Users\\me\\.claude\\jev\\rule_enforcer.py" }] },
                { "matcher": "Write", "hooks": [{ "command": "\"C:/Py/python.exe\" C:/Users/me/.claude/jev/rule_enforcer.py" }] },
                { "hooks": [{ "command": "node other-tool.js" }] }
            ]
        }});
        let (hooks, python) = registered_hooks(&settings);
        assert_eq!(python.as_deref(), Some("C:/Py/python.exe"));
        let names: Vec<_> = hooks.iter().map(|hook| (hook.event.as_str(), hook.script.as_str())).collect();
        assert_eq!(names, vec![("PreToolUse", "rule_enforcer.py"), ("Stop", "stop_verifier.py")]);
    }

    #[test]
    fn keeps_only_the_times_jev_acted() {
        let records = [
            json!({ "ts": "2026-10-09T10:00:00", "hook": "stop_verifier", "event": "completion_verdict", "mode": "block", "would": "flag" }),
            json!({ "ts": "2026-10-09T10:01:00", "hook": "stop_verifier", "event": "completion_verdict", "mode": "block", "would": "pass" }),
            json!({ "ts": "2026-10-09T10:02:00", "hook": "stop_verifier", "event": "completion_verdict", "mode": "shadow", "would": "flag" }),
            json!({ "ts": "2026-10-09T10:03:00", "hook": "remote_enforcer", "event": "verdict", "deny": 1, "ask": 0, "project": "Crestbid" }),
            json!({ "ts": "2026-10-09T10:04:00", "hook": "rule_enforcer", "event": "verdict", "deny": 0, "ask": 0 }),
            json!({ "ts": "2026-10-09T10:05:00", "hook": "global_guard", "event": "guard", "kinds": ["`git restore .` throws away uncommitted changes"] }),
            json!({ "ts": "2026-10-09T10:06:00", "hook": "command_risk", "event": "command_risk", "mode": "shadow", "verdict": "ask" }),
            json!({ "ts": "2026-10-09T10:07:00", "hook": "compact_resume", "event": "compaction_loop", "count": 3 }),
            json!({ "ts": "2026-10-09T10:08:00", "hook": "rule_enforcer", "event": "deterministic_block", "kinds": ["secret"] }),
        ];
        let lines: Vec<String> = records.iter().map(Value::to_string).collect();
        let found = recent_interventions(&lines, "2026-10-01T00:00:00", 10);
        let kinds: Vec<_> = found.iter().map(|item| (item.kind, item.detail.as_str())).collect();
        assert_eq!(kinds, vec![
            ("blocked", "secret"),
            ("loopStopped", "3"),
            ("guarded", "`git restore .` throws away uncommitted changes"),
            ("blocked", "remote patch"),
            ("sentBack", ""),
        ]);
        assert_eq!(found[3].project.as_deref(), Some("Crestbid"));
    }

    #[test]
    fn skips_old_records_and_bad_lines_and_honours_the_limit() {
        let lines = vec![
            "not json".to_string(),
            json!({ "ts": "2026-09-01T00:00:00", "hook": "compact_resume", "event": "compaction_loop", "count": 3 }).to_string(),
            json!({ "ts": "2026-10-09T00:00:00", "hook": "compact_resume", "event": "compaction_loop", "count": "4" }).to_string(),
            json!({ "ts": "2026-10-09T01:00:00", "hook": "compact_resume", "event": "compaction_loop", "count": 5 }).to_string(),
        ];
        let found = recent_interventions(&lines, "2026-10-01T00:00:00", 1);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].detail, "5");
    }

    #[test]
    fn reads_the_interpreter_from_quoted_and_plain_commands() {
        assert_eq!(interpreter("\"C:/Py 3/python.exe\" x.py").as_deref(), Some("C:/Py 3/python.exe"));
        assert_eq!(interpreter("python3 x.py").as_deref(), Some("python3"));
        assert_eq!(interpreter("node x.js"), None);
    }

    #[test]
    fn summary_keeps_the_page_fields_only() {
        let report = json!({ "generated": "g", "days": 7, "charts": { "big": true }, "compactions": [1, 2], "alerts": ["a"] });
        assert_eq!(report_summary(&report), json!({ "generated": "g", "days": 7, "alerts": ["a"] }));
    }
}
