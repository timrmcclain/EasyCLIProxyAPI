//! "Switch Claude Code to…" for when every Claude account is out.
//!
//! Switching saves Claude Code's model settings exactly as they are, then points
//! them all at the chosen model, which the proxy serves from another provider.
//! Switching back restores the saved values, including removing ones that
//! weren't set before. Nothing changes unless the user clicks.

use crate::statusline::{read_settings, write_settings};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Every setting Claude Code reads a model from. `None` is the top-level `model` key.
const ENV_KEYS: [&str; 6] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];
const SAVED_FILE: &str = "claude-models-before-switch.json";

struct Paths {
    settings: PathBuf,
    saved: PathBuf,
}

impl Paths {
    fn resolve(app: &tauri::AppHandle) -> Result<Self, String> {
        let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Local"));
        Ok(Paths { settings: home.join(".claude/settings.json"), saved: local.join("TimAIHub").join(SAVED_FILE) })
    }
}

/// The current model settings, with `null` for ones that aren't set.
fn capture(settings: &Map<String, Value>) -> Map<String, Value> {
    let env = settings.get("env").and_then(Value::as_object);
    let mut saved = Map::new();
    for key in ENV_KEYS {
        saved.insert(key.into(), env.and_then(|env| env.get(key)).cloned().unwrap_or(Value::Null));
    }
    saved.insert("model".into(), settings.get("model").cloned().unwrap_or(Value::Null));
    // Switching creates "env" when there is none; remembered so switching back removes it again.
    saved.insert(HAD_ENV.into(), Value::Bool(settings.contains_key("env")));
    saved
}

const HAD_ENV: &str = "hadEnv";

fn point_at(settings: &mut Map<String, Value>, model: &str) {
    let env = settings.entry("env").or_insert_with(|| Value::Object(Map::new()));
    if !env.is_object() {
        *env = Value::Object(Map::new());
    }
    let env = env.as_object_mut().expect("env is an object");
    for key in ENV_KEYS {
        env.insert(key.into(), Value::String(model.into()));
    }
    settings.insert("model".into(), Value::String(model.into()));
}

fn restore(settings: &mut Map<String, Value>, saved: &Map<String, Value>) {
    let put = |map: &mut Map<String, Value>, key: &str, value: Option<&Value>| match value {
        Some(Value::Null) | None => { map.remove(key); }
        Some(value) => { map.insert(key.into(), value.clone()); }
    };
    let mut env_now_empty = false;
    if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
        for key in ENV_KEYS {
            put(env, key, saved.get(key));
        }
        env_now_empty = env.is_empty();
    }
    // Copies saved before this was recorded keep "env" as it is.
    if env_now_empty && saved.get(HAD_ENV) == Some(&Value::Bool(false)) {
        settings.remove("env");
    }
    put(settings, "model", saved.get("model"));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeFallbackState {
    /// The model Claude Code was switched to, while switched.
    model: Option<String>,
}

fn state(paths: &Paths) -> Result<ClaudeFallbackState, String> {
    if !paths.saved.is_file() {
        return Ok(ClaudeFallbackState { model: None });
    }
    let settings = read_settings(&paths.settings)?;
    Ok(ClaudeFallbackState { model: settings.get("model").and_then(Value::as_str).map(str::to_string) })
}

fn read_saved(path: &Path) -> Option<Map<String, Value>> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

#[tauri::command]
pub(crate) fn claude_fallback_state(app: tauri::AppHandle) -> Result<ClaudeFallbackState, String> {
    state(&Paths::resolve(&app)?)
}

#[tauri::command]
pub(crate) fn switch_claude_code_model(app: tauri::AppHandle, model: String) -> Result<ClaudeFallbackState, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Choose a model to switch to".into());
    }
    let paths = Paths::resolve(&app)?;
    let mut settings = read_settings(&paths.settings)?;
    // Keep the first saved copy if switching again, so "Switch back" always returns to the original.
    if !paths.saved.is_file() {
        fs::create_dir_all(paths.saved.parent().unwrap_or(Path::new(".")))
            .map_err(|error| format!("Failed to create {}: {error}", paths.saved.display()))?;
        let text = serde_json::to_string_pretty(&capture(&settings)).map_err(|error| error.to_string())?;
        fs::write(&paths.saved, text).map_err(|error| format!("Failed to save Claude Code's models: {error}"))?;
    }
    point_at(&mut settings, model);
    write_settings(&paths.settings, &settings)?;
    state(&paths)
}

#[tauri::command]
pub(crate) fn switch_claude_code_back(app: tauri::AppHandle) -> Result<ClaudeFallbackState, String> {
    let paths = Paths::resolve(&app)?;
    let Some(saved) = read_saved(&paths.saved) else {
        return state(&paths);
    };
    let mut settings = read_settings(&paths.settings)?;
    restore(&mut settings, &saved);
    write_settings(&paths.settings, &settings)?;
    let _ = fs::remove_file(&paths.saved);
    state(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn switching_and_back_restores_every_model_setting_exactly() {
        let original = object(json!({
            "model": "opus",
            "env": { "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5", "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "OTHER": "kept" },
            "statusLine": { "type": "command" }
        }));
        let mut settings = original.clone();
        let saved = capture(&settings);
        point_at(&mut settings, "gpt-5.5");
        assert_eq!(settings["model"], json!("gpt-5.5"));
        for key in ENV_KEYS {
            assert_eq!(settings["env"][key], json!("gpt-5.5"), "{key}");
        }
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], json!("http://127.0.0.1:8317"));
        restore(&mut settings, &saved);
        assert_eq!(settings, original);
    }

    #[test]
    fn switching_back_removes_settings_that_were_not_there_before() {
        let original = object(json!({ "env": {} }));
        let mut settings = original.clone();
        let saved = capture(&settings);
        point_at(&mut settings, "grok-5");
        restore(&mut settings, &saved);
        assert_eq!(settings, original);
    }

    #[test]
    fn a_settings_file_without_env_still_switches() {
        let mut settings = object(json!({}));
        point_at(&mut settings, "gemini-3-pro");
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], json!("gemini-3-pro"));
    }

    #[test]
    fn switching_back_removes_the_env_block_switching_created() {
        let original = object(json!({ "model": "opus" }));
        let mut settings = original.clone();
        let saved = capture(&settings);
        point_at(&mut settings, "gpt-5.5");
        restore(&mut settings, &saved);
        assert_eq!(settings, original);
    }

    #[test]
    fn an_older_saved_copy_keeps_env_as_it_is() {
        let mut settings = object(json!({ "env": { "ANTHROPIC_MODEL": "x" } }));
        let mut saved = capture(&object(json!({ "env": {} })));
        saved.remove(HAD_ENV);
        restore(&mut settings, &saved);
        assert_eq!(settings, object(json!({ "env": {} })));
    }
}
