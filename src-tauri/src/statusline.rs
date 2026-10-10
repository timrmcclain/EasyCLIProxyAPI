//! Adds the hub's quota line to Claude Code's status line.
//!
//! Enabling saves the user's existing `statusLine` setting, then points Claude
//! Code at a small bash wrapper that runs the original command unchanged and
//! prints the quota line under it. The quota watcher refreshes the line every
//! few minutes. Disabling restores the saved setting exactly.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const WRAPPER_NAME: &str = "claude-statusline.sh";
const QUOTA_FILE: &str = "quota.txt";
const ORIGINAL_SETTING_FILE: &str = "original-statusline.json";
const ORIGINAL_COMMAND_FILE: &str = "original-command.txt";
/// Minutes after which the quota line is marked stale (the hub may be closed).
const STALE_MINUTES: u32 = 15;

struct Paths {
    settings: PathBuf,
    directory: PathBuf,
    backups: PathBuf,
}

impl Paths {
    fn resolve(app: &tauri::AppHandle) -> Result<Self, String> {
        let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Local"));
        Ok(Paths {
            settings: home.join(".claude/settings.json"),
            directory: local.join("TimAIHub/statusline"),
            backups: local.join("TimAIHub/backups"),
        })
    }

    fn wrapper(&self) -> PathBuf {
        self.directory.join(WRAPPER_NAME)
    }
}

fn forward_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn wrapper_command(wrapper: &Path) -> String {
    format!("bash \"{}\"", forward_slashes(wrapper))
}

/// True when this `statusLine` value is the hub's wrapper.
fn is_hub_status_line(value: Option<&Value>) -> bool {
    value
        .and_then(|line| line.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|command| command.replace('\\', "/").contains(&format!("TimAIHub/statusline/{WRAPPER_NAME}")))
}

/// Points the settings at the wrapper. Returns the replaced setting (`Null`
/// when there was none) so it can be restored later.
fn wrap_settings(settings: &mut Map<String, Value>, command: &str) -> Value {
    let original = settings.get("statusLine").cloned().unwrap_or(Value::Null);
    settings.insert("statusLine".to_string(), json!({ "type": "command", "command": command, "padding": 0 }));
    original
}

/// Puts the saved setting back. Leaves the settings alone unless the hub's
/// wrapper is still the active status line.
fn unwrap_settings(settings: &mut Map<String, Value>, original: &Value) -> bool {
    if !is_hub_status_line(settings.get("statusLine")) {
        return false;
    }
    if original.is_null() {
        settings.remove("statusLine");
    } else {
        settings.insert("statusLine".to_string(), original.clone());
    }
    true
}

/// The original command to run first, when the saved setting is a command.
fn original_command(original: &Value) -> Option<String> {
    original
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .map(str::to_string)
}

fn wrapper_script(directory: &Path) -> String {
    let directory = forward_slashes(directory);
    format!(
        r#"#!/usr/bin/env bash
# Written by the AI hub. Runs your original status line, then the quota line.
dir="{directory}"
input=$(cat)
if [ -s "$dir/{ORIGINAL_COMMAND_FILE}" ]; then
  original=$(cat "$dir/{ORIGINAL_COMMAND_FILE}")
  output=$(printf '%s' "$input" | eval "$original" 2>/dev/null)
  [ -n "$output" ] && printf '%s\n' "$output"
fi
quota="$dir/{QUOTA_FILE}"
if [ -s "$quota" ]; then
  line=$(cat "$quota")
  if [ -n "$(find "$quota" -mmin +{STALE_MINUTES} 2>/dev/null)" ]; then
    line="$line (not updated recently)"
  fi
  printf '%s' "$line"
fi
"#
    )
}

fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.is_file() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(error) => Err(format!("{} is not valid JSON: {error}", path.display())),
    }
}

fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, text + "\n").map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn backup_settings(paths: &Paths) -> Result<(), String> {
    if !paths.settings.is_file() {
        return Ok(());
    }
    fs::create_dir_all(&paths.backups).map_err(|error| format!("Failed to create backup folder: {error}"))?;
    let target = paths
        .backups
        .join(format!("statusline-settings-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    fs::copy(&paths.settings, &target)
        .map(|_| ())
        .map_err(|error| format!("Failed to back up {}: {error}", paths.settings.display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeStatusLineState {
    enabled: bool,
    /// Whether a status line other than the hub's was configured before.
    wraps_existing: bool,
}

fn state(paths: &Paths) -> Result<ClaudeStatusLineState, String> {
    let settings = read_settings(&paths.settings)?;
    let enabled = is_hub_status_line(settings.get("statusLine"));
    let wraps_existing = enabled && paths.directory.join(ORIGINAL_COMMAND_FILE).is_file();
    Ok(ClaudeStatusLineState { enabled, wraps_existing })
}

#[tauri::command]
pub(crate) fn claude_statusline_state(app: tauri::AppHandle) -> Result<ClaudeStatusLineState, String> {
    state(&Paths::resolve(&app)?)
}

#[tauri::command]
pub(crate) fn enable_claude_statusline(app: tauri::AppHandle) -> Result<ClaudeStatusLineState, String> {
    let paths = Paths::resolve(&app)?;
    let mut settings = read_settings(&paths.settings)?;
    fs::create_dir_all(&paths.directory).map_err(|error| format!("Failed to create {}: {error}", paths.directory.display()))?;
    fs::write(paths.wrapper(), wrapper_script(&paths.directory))
        .map_err(|error| format!("Failed to write the status line script: {error}"))?;
    if !is_hub_status_line(settings.get("statusLine")) {
        backup_settings(&paths)?;
        let original = wrap_settings(&mut settings, &wrapper_command(&paths.wrapper()));
        let saved = serde_json::to_string_pretty(&original).map_err(|error| error.to_string())?;
        fs::write(paths.directory.join(ORIGINAL_SETTING_FILE), saved)
            .map_err(|error| format!("Failed to save the original status line: {error}"))?;
        let command_file = paths.directory.join(ORIGINAL_COMMAND_FILE);
        match original_command(&original) {
            Some(command) => fs::write(&command_file, command)
                .map_err(|error| format!("Failed to save the original status line: {error}"))?,
            None => {
                let _ = fs::remove_file(&command_file);
            }
        }
        write_settings(&paths.settings, &settings)?;
    }
    state(&paths)
}

#[tauri::command]
pub(crate) fn disable_claude_statusline(app: tauri::AppHandle) -> Result<ClaudeStatusLineState, String> {
    let paths = Paths::resolve(&app)?;
    let mut settings = read_settings(&paths.settings)?;
    let saved = fs::read_to_string(paths.directory.join(ORIGINAL_SETTING_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    if is_hub_status_line(settings.get("statusLine")) {
        backup_settings(&paths)?;
        unwrap_settings(&mut settings, &saved);
        write_settings(&paths.settings, &settings)?;
    }
    let _ = fs::remove_file(paths.directory.join(ORIGINAL_SETTING_FILE));
    let _ = fs::remove_file(paths.directory.join(ORIGINAL_COMMAND_FILE));
    state(&paths)
}

/// Called by the quota watcher with the latest one-line summary.
#[tauri::command]
pub(crate) fn write_claude_quota_line(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let paths = Paths::resolve(&app)?;
    fs::create_dir_all(&paths.directory).map_err(|error| format!("Failed to create {}: {error}", paths.directory.display()))?;
    fs::write(paths.directory.join(QUOTA_FILE), text.trim()).map_err(|error| format!("Failed to write the quota line: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WRAPPER: &str = "bash \"C:/Users/me/AppData/Local/TimAIHub/statusline/claude-statusline.sh\"";

    #[test]
    fn wrapping_saves_the_existing_status_line_and_unwrapping_restores_it() {
        let existing = json!({ "type": "command", "command": "python guard.py", "padding": 2 });
        let mut settings = Map::new();
        settings.insert("statusLine".into(), existing.clone());
        settings.insert("model".into(), json!("opus"));

        let original = wrap_settings(&mut settings, WRAPPER);
        assert_eq!(original, existing);
        assert!(is_hub_status_line(settings.get("statusLine")));
        assert_eq!(original_command(&original).as_deref(), Some("python guard.py"));

        assert!(unwrap_settings(&mut settings, &original));
        assert_eq!(settings.get("statusLine"), Some(&existing));
        assert_eq!(settings.get("model"), Some(&json!("opus")));
    }

    #[test]
    fn unwrapping_removes_the_setting_when_there_was_none_before() {
        let mut settings = Map::new();
        let original = wrap_settings(&mut settings, WRAPPER);
        assert!(original.is_null());
        assert_eq!(original_command(&original), None);
        assert!(unwrap_settings(&mut settings, &original));
        assert!(!settings.contains_key("statusLine"));
    }

    #[test]
    fn unwrapping_leaves_a_status_line_the_user_changed_since() {
        let mut settings = Map::new();
        settings.insert("statusLine".into(), json!({ "type": "command", "command": "my-own-line" }));
        assert!(!unwrap_settings(&mut settings, &Value::Null));
        assert_eq!(settings["statusLine"]["command"], json!("my-own-line"));
    }

    #[test]
    fn hub_status_line_is_recognised_with_either_slash_style() {
        assert!(is_hub_status_line(Some(&json!({ "command": WRAPPER }))));
        assert!(is_hub_status_line(Some(&json!({
            "command": "bash \"C:\\Users\\me\\AppData\\Local\\TimAIHub\\statusline\\claude-statusline.sh\""
        }))));
        assert!(!is_hub_status_line(Some(&json!({ "command": "python guard.py" }))));
        assert!(!is_hub_status_line(None));
    }

    #[test]
    fn wrapper_runs_the_original_first_then_the_quota_line() {
        let script = wrapper_script(Path::new("C:\\Users\\me\\TimAIHub\\statusline"));
        assert!(script.contains("dir=\"C:/Users/me/TimAIHub/statusline\""));
        let original_at = script.find("eval \"$original\"").expect("runs the original");
        let quota_at = script.find("printf '%s' \"$line\"").expect("prints the quota line");
        assert!(original_at < quota_at);
        assert!(script.contains("-mmin +15"));
    }
}
