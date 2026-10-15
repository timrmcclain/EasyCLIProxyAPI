//! Versions of the proxy's config.yaml, so a bad settings change can be undone. A version is saved whenever the file's
//! content changes, whoever wrote it (the hub, the proxy's own management API, or a text editor), and once at startup.
//! Versions sit in `config-history/` beside the config, which already holds the same secrets; the newest 20 are kept.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::Serialize;

use crate::{core_install_dir, lock_core_config_file, write_core_config_if_changed, CORE_CONFIG_FILE};

const KEEP: usize = 20;
const PREFIX: &str = "config-";
const SUFFIX: &str = ".yaml";
const STAMP: &str = "%Y%m%d-%H%M%S-%3f";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigVersion {
    name: String,
    saved_at: String,
    size: u64,
    /// Same content as the config file right now.
    current: bool,
}

fn history_dir(config: &Path) -> PathBuf {
    config.parent().unwrap_or_else(|| Path::new(".")).join("config-history")
}

/// A version's time, or None for anything that isn't a version file (so stray files are never listed or restored).
fn parse_name(name: &str) -> Option<DateTime<Local>> {
    let stamp = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let naive = NaiveDateTime::parse_from_str(stamp, STAMP).ok()?;
    Local.from_local_datetime(&naive).earliest()
}

/// Version file names, newest first.
fn version_names(config: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(history_dir(config))
        .map(|entries| entries.flatten().filter_map(|entry| entry.file_name().into_string().ok()).filter(|name| parse_name(name).is_some()).collect())
        .unwrap_or_default();
    // The timestamp format sorts lexically.
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

/// Saves the config's current content as a new version unless the newest version already has it. Returns whether it saved.
pub(crate) fn record_at(config: &Path, now: DateTime<Local>) -> Result<bool, String> {
    // The file watcher and Restore both record; without this, two at once could each miss the other's
    // new version and save a duplicate, pushing an older version out of the newest 20.
    static RECORDING: Mutex<()> = Mutex::new(());
    let _recording = RECORDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(content) = fs::read(config) else { return Ok(false) };
    let names = version_names(config);
    let dir = history_dir(config);
    if let Some(newest) = names.first() {
        if fs::read(dir.join(newest)).ok().as_deref() == Some(content.as_slice()) {
            return Ok(false);
        }
    }
    fs::create_dir_all(&dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    let mut name = format!("{PREFIX}{}{SUFFIX}", now.format(STAMP));
    // Two saves in the same millisecond: nudge forward so the newer one still sorts first.
    let mut bump = now;
    while names.first().is_some_and(|newest| *newest >= name) {
        bump += chrono::Duration::milliseconds(1);
        name = format!("{PREFIX}{}{SUFFIX}", bump.format(STAMP));
    }
    fs::write(dir.join(&name), &content).map_err(|error| format!("Couldn't save config version: {error}"))?;
    for old in version_names(config).into_iter().skip(KEEP) {
        let _ = fs::remove_file(dir.join(old));
    }
    Ok(true)
}

pub(crate) fn record(config: &Path) -> Result<bool, String> {
    record_at(config, Local::now())
}

pub(crate) fn list_at(config: &Path) -> Vec<ConfigVersion> {
    let current = fs::read(config).ok();
    let dir = history_dir(config);
    version_names(config)
        .into_iter()
        .filter_map(|name| {
            let content = fs::read(dir.join(&name)).ok()?;
            let saved_at = parse_name(&name)?.to_rfc3339();
            Some(ConfigVersion { current: current.as_deref() == Some(content.as_slice()), size: content.len() as u64, saved_at, name })
        })
        .collect()
}

/// Writes a saved version back as the config. The proxy reloads config.yaml when it changes.
pub(crate) fn restore_at(config: &Path, name: &str) -> Result<(), String> {
    if parse_name(name).is_none() {
        return Err(format!("{name} isn't a saved config version."));
    }
    let content = fs::read_to_string(history_dir(config).join(name)).map_err(|error| format!("Couldn't read {name}: {error}"))?;
    serde_yaml::from_str::<serde_yaml::Value>(&content).map_err(|error| format!("{name} isn't valid YAML, so it wasn't restored: {error}"))?;
    // Keep what's being replaced, in case it was never recorded.
    record(config)?;
    write_core_config_if_changed(config, &content)?;
    record(config)?;
    Ok(())
}

fn core_config_path() -> Result<PathBuf, String> {
    Ok(core_install_dir()?.join(CORE_CONFIG_FILE))
}

#[tauri::command]
pub(crate) fn list_core_config_history() -> Result<Vec<ConfigVersion>, String> {
    let path = core_config_path()?;
    let _ = record(&path);
    Ok(list_at(&path))
}

#[tauri::command]
pub(crate) fn restore_core_config_history(name: String) -> Result<(), String> {
    let path = core_config_path()?;
    let _guard = lock_core_config_file()?;
    restore_at(&path, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 10, 12, minute, 0).unwrap()
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_config(content: &str) -> (TempDir, PathBuf) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("cpa-config-history-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        fs::write(&path, content).unwrap();
        (TempDir(dir), path)
    }

    #[test]
    fn saves_a_version_only_when_the_content_changes() {
        let (_dir, config) = temp_config("port: 8317\n");
        assert!(record_at(&config, at(0)).unwrap());
        assert!(!record_at(&config, at(1)).unwrap());
        fs::write(&config, "port: 8318\n").unwrap();
        assert!(record_at(&config, at(2)).unwrap());
        let versions = list_at(&config);
        assert_eq!(versions.len(), 2);
        assert!(versions[0].current && !versions[1].current, "newest first, and the newest matches the file");
    }

    #[test]
    fn saves_at_the_same_moment_make_one_version() {
        let (_dir, config) = temp_config("port: 8317\n");
        let saved: usize = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8).map(|i| scope.spawn({ let config = &config; move || record_at(config, at(i)).unwrap() })).collect();
            handles.into_iter().map(|handle| usize::from(handle.join().unwrap())).sum()
        });
        assert_eq!(saved, 1);
        assert_eq!(version_names(&config).len(), 1);
    }

    #[test]
    fn keeps_only_the_newest_twenty_and_ignores_other_files() {
        let (_dir, config) = temp_config("v: 0\n");
        for minute in 0..25 {
            fs::write(&config, format!("v: {minute}\n")).unwrap();
            record_at(&config, at(minute)).unwrap();
        }
        fs::write(history_dir(&config).join("notes.txt"), "not a version").unwrap();
        let versions = list_at(&config);
        assert_eq!(versions.len(), KEEP);
        assert!(versions[0].name.contains("1224"), "{}", versions[0].name);
    }

    #[test]
    fn restores_a_version_and_keeps_the_replaced_one() {
        let (_dir, config) = temp_config("port: 8317\n");
        record_at(&config, at(0)).unwrap();
        let first = list_at(&config)[0].name.clone();
        fs::write(&config, "port: 9999\n").unwrap();
        restore_at(&config, &first).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), "port: 8317\n");
        let contents: Vec<String> = version_names(&config).iter().map(|name| fs::read_to_string(history_dir(&config).join(name)).unwrap()).collect();
        assert!(contents.contains(&"port: 9999\n".to_string()), "the replaced content was saved before restoring");
    }

    #[test]
    fn refuses_names_outside_the_history_and_invalid_yaml() {
        let (_dir, config) = temp_config("port: 8317\n");
        assert!(restore_at(&config, "../config.yaml").is_err());
        assert!(restore_at(&config, "config-20261010.yaml").is_err());
        fs::create_dir_all(history_dir(&config)).unwrap();
        fs::write(history_dir(&config).join("config-20261010-120000-000.yaml"), "port: [unclosed\n").unwrap();
        assert!(restore_at(&config, "config-20261010-120000-000.yaml").unwrap_err().contains("isn't valid YAML"));
        assert_eq!(fs::read_to_string(&config).unwrap(), "port: 8317\n");
    }
}
