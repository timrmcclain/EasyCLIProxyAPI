//! Deleting an account keeps a copy of its file for 7 days, so the delete can be undone. Copies live in the
//! hub's own folder, never inside the accounts folder, where the proxy would load them again.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::core_runtime::core_base_dir;
use crate::management_api::upload_credential;
use crate::{auth_dir_path_for_core, core_install_dir, path_to_string, GuiConfigState};

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn deleted_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("deleted-accounts"))
}

/// A bare `name.json`: no folders, so a name can never reach outside the accounts folder.
fn checked_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let plain = !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && name.to_ascii_lowercase().ends_with(".json");
    if plain { Ok(name) } else { Err(format!("Not an account file name: {name}")) }
}

/// Copies `name` from the accounts folder into `deleted`, as `<unix seconds>-<name>`, and clears copies
/// older than 7 days. Returns the copy's id for Undo.
pub(crate) fn keep_copy(auth_dir: &Path, deleted: &Path, name: &str, now: SystemTime) -> Result<String, String> {
    let name = checked_name(name)?;
    if deleted.starts_with(auth_dir) {
        return Err("The deleted-accounts folder can't be inside the accounts folder".to_string());
    }
    let source = auth_dir.join(name);
    let data = fs::read(&source).map_err(|error| format!("Couldn't read {}: {error}", path_to_string(&source)))?;
    fs::create_dir_all(deleted).map_err(|error| format!("Couldn't create {}: {error}", path_to_string(deleted)))?;
    clear_expired(deleted, now);
    let stamp = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let id = format!("{stamp}-{name}");
    let target = deleted.join(&id);
    fs::write(&target, data).map_err(|error| format!("Couldn't save {}: {error}", path_to_string(&target)))?;
    Ok(id)
}

/// Removes kept copies whose timestamp is more than 7 days old. Files it doesn't recognise are left alone.
pub(crate) fn clear_expired(deleted: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(deleted) else { return };
    let now = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(stamp) = file_name.to_str().and_then(|n| n.split_once('-')).and_then(|(s, _)| s.parse::<u64>().ok()) else { continue };
        if now.saturating_sub(stamp) > KEEP_FOR.as_secs() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The original file name and contents of a kept copy.
pub(crate) fn read_copy(deleted: &Path, id: &str) -> Result<(String, Vec<u8>), String> {
    let id = checked_name(id)?;
    let name = id.split_once('-').map(|(_, rest)| rest).filter(|rest| !rest.is_empty())
        .ok_or_else(|| format!("Not a kept account copy: {id}"))?;
    let data = fs::read(deleted.join(id)).map_err(|_| "This account's copy is no longer kept (copies last 7 days)".to_string())?;
    Ok((name.to_string(), data))
}

/// Before the proxy deletes an account: keep a copy for Undo. Nothing should be deleted if this fails.
#[tauri::command]
pub(crate) fn keep_deleted_account(gui_config_state: tauri::State<'_, GuiConfigState>, name: String) -> Result<String, String> {
    let config = gui_config_state.snapshot()?;
    let auth_dir = auth_dir_path_for_core(&config.auth_dir, &core_install_dir()?)?;
    keep_copy(&auth_dir, &deleted_dir()?, &name, SystemTime::now())
}

/// Undo: uploads the kept copy back through the proxy, then removes the copy.
#[tauri::command]
pub(crate) async fn restore_deleted_account(gui_config_state: tauri::State<'_, GuiConfigState>, id: String) -> Result<String, String> {
    let config = gui_config_state.snapshot()?;
    let deleted = deleted_dir()?;
    let (name, data) = read_copy(&deleted, &id)?;
    upload_credential(&config, &name, data).await?;
    let _ = fs::remove_file(deleted.join(checked_name(&id)?));
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deleted-accounts-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_a_copy_that_can_be_read_back() {
        let root = temp("keep");
        let (auth, deleted) = (root.join("auth"), root.join("deleted"));
        fs::create_dir_all(&auth).unwrap();
        fs::write(auth.join("claude-a.json"), b"{\"type\":\"claude\"}").unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let id = keep_copy(&auth, &deleted, "claude-a.json", now).unwrap();
        assert_eq!(id, "1000000-claude-a.json");
        assert_eq!(read_copy(&deleted, &id).unwrap(), ("claude-a.json".to_string(), b"{\"type\":\"claude\"}".to_vec()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_paths_and_a_folder_inside_the_accounts_folder() {
        let root = temp("refuse");
        let auth = root.join("auth");
        fs::create_dir_all(&auth).unwrap();
        let now = SystemTime::now();
        assert!(keep_copy(&auth, &root.join("deleted"), "../secret.json", now).is_err());
        assert!(keep_copy(&auth, &root.join("deleted"), "notes.txt", now).is_err());
        fs::write(auth.join("x.json"), b"{}").unwrap();
        assert!(keep_copy(&auth, &auth.join("deleted"), "x.json", now).is_err());
        assert!(read_copy(&root, "..\\x.json").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clears_copies_older_than_seven_days_only() {
        let root = temp("expire");
        let day = 24 * 60 * 60;
        let now = 100 * day;
        fs::write(root.join(format!("{}-old.json", now - 8 * day)), b"{}").unwrap();
        fs::write(root.join(format!("{}-new.json", now - 6 * day)), b"{}").unwrap();
        fs::write(root.join("readme.txt"), b"keep").unwrap();
        clear_expired(&root, UNIX_EPOCH + Duration::from_secs(now));
        let mut left: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec![format!("{}-new.json", now - 6 * day), "readme.txt".to_string()]);
        let _ = fs::remove_dir_all(root);
    }
}
