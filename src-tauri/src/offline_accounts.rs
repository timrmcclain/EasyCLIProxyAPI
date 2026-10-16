//! A read-only look at the accounts folder while the proxy is stopped. Only identifying, non-secret fields are
//! returned; tokens and keys in the files never leave the backend.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::{auth_dir_path_for_core, core_install_dir, path_to_string, GuiConfigState};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineAccount {
    name: String,
    provider: String,
    email: String,
    disabled: bool,
    priority: i64,
    /// Last change to the file, in Unix milliseconds.
    modified_ms: u64,
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|key| value.get(*key).and_then(Value::as_str)).unwrap_or("").trim().to_string()
}

/// Reads every `*.json` account file in `dir`, newest priority first, then by name. Files that aren't JSON
/// objects are skipped rather than failing the whole list.
pub(crate) fn read_accounts(dir: &Path) -> Result<Vec<OfflineAccount>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Couldn't read {}: {error}", path_to_string(dir))),
    };
    let mut accounts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if !path.is_file() || !name.to_ascii_lowercase().ends_with(".json") { continue }
        let Ok(raw) = fs::read(&path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&raw) else { continue };
        if !value.is_object() { continue }
        let modified_ms = entry.metadata().ok().and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        accounts.push(OfflineAccount {
            provider: text(&value, &["type", "provider"]).to_ascii_lowercase(),
            email: text(&value, &["email", "account", "label"]),
            disabled: value.get("disabled").and_then(Value::as_bool).unwrap_or(false),
            priority: value.get("priority").and_then(|p| p.as_i64().or_else(|| p.as_str().and_then(|s| s.trim().parse().ok()))).unwrap_or(0),
            modified_ms,
            name,
        });
    }
    accounts.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.name.cmp(&b.name)));
    Ok(accounts)
}

#[tauri::command]
pub(crate) fn list_offline_accounts(gui_config_state: tauri::State<'_, GuiConfigState>) -> Result<Vec<OfflineAccount>, String> {
    let config = gui_config_state.snapshot()?;
    read_accounts(&auth_dir_path_for_core(&config.auth_dir, &core_install_dir()?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_identity_fields_only_in_routing_order() {
        let dir = std::env::temp_dir().join(format!("offline-accounts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.json"), r#"{"type":"Claude","email":"b@example.test","access_token":"secret-token","priority":"2"}"#).unwrap();
        fs::write(dir.join("a.json"), r#"{"type":"codex","email":"a@example.test","disabled":true}"#).unwrap();
        fs::write(dir.join("broken.json"), "not json").unwrap();
        fs::write(dir.join("notes.txt"), "{}").unwrap();
        let accounts = read_accounts(&dir).unwrap();
        assert_eq!(accounts.iter().map(|a| (a.name.as_str(), a.provider.as_str(), a.priority, a.disabled)).collect::<Vec<_>>(),
            vec![("b.json", "claude", 2, false), ("a.json", "codex", 0, true)]);
        let json = serde_json::to_string(&accounts).unwrap();
        assert!(!json.contains("secret-token"), "tokens never leave the backend");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_folder_is_an_empty_list() {
        assert_eq!(read_accounts(&std::env::temp_dir().join("offline-accounts-missing-folder")).unwrap(), Vec::new());
    }
}
