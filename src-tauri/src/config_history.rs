//! Versions of the proxy's config.yaml, so a bad settings change can be undone. A version is saved whenever the file's
//! content changes, whoever wrote it (the hub, the proxy's own management API, or a text editor), and once at startup.
//! Versions sit in `config-history/` beside the config, which already holds the same secrets. The newest 20 are kept,
//! plus anything from the last 14 days, up to 200 in all.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::Serialize;

use crate::{core_install_dir, lock_core_config_file, write_core_config_if_changed, CORE_CONFIG_FILE};

const KEEP: usize = 20;
const KEEP_DAYS: i64 = 14;
const KEEP_MAX: usize = 200;
/// Changed settings listed per version; the rest are counted.
const MAX_CHANGES: usize = 8;
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
    /// Settings this version changed from the one before it: names only, never values, since the config holds keys.
    changes: Vec<String>,
    /// How many more changed beyond `changes`.
    more_changes: usize,
    /// Settings that restoring this version would change in the current config.
    restore_changes: Vec<String>,
    more_restore_changes: usize,
}

/// Dotted names of the settings that differ, depth-limited so lists of keys show as one entry and values never appear.
fn changed_paths(before: &serde_yaml::Value, after: &serde_yaml::Value) -> Vec<String> {
    fn walk(path: &str, a: Option<&serde_yaml::Value>, b: Option<&serde_yaml::Value>, depth: usize, out: &mut Vec<String>) {
        if a == b {
            return;
        }
        if let (Some(serde_yaml::Value::Mapping(left)), Some(serde_yaml::Value::Mapping(right))) = (a, b) {
            if depth < 3 {
                let mut keys: Vec<String> = left.keys().chain(right.keys()).filter_map(|key| key.as_str().map(str::to_string)).collect();
                keys.sort();
                keys.dedup();
                for key in keys {
                    let child = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    let key_value = serde_yaml::Value::String(key);
                    walk(&child, left.get(&key_value), right.get(&key_value), depth + 1, out);
                }
                return;
            }
        }
        out.push(if path.is_empty() { "(whole file)".to_string() } else { path.to_string() });
    }
    let mut out = Vec::new();
    walk("", Some(before), Some(after), 0, &mut out);
    out
}

fn summarize(paths: Vec<String>) -> (Vec<String>, usize) {
    let more = paths.len().saturating_sub(MAX_CHANGES);
    (paths.into_iter().take(MAX_CHANGES).collect(), more)
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
    let cutoff = now - chrono::Duration::days(KEEP_DAYS);
    for (index, old) in version_names(config).into_iter().enumerate().skip(KEEP) {
        let recent = parse_name(&old).is_some_and(|saved| saved >= cutoff);
        if index >= KEEP_MAX || !recent {
            let _ = fs::remove_file(dir.join(old));
        }
    }
    Ok(true)
}

pub(crate) fn record(config: &Path) -> Result<bool, String> {
    record_at(config, Local::now())
}

pub(crate) fn list_at(config: &Path) -> Vec<ConfigVersion> {
    let current = fs::read(config).ok();
    let parse = |bytes: &[u8]| serde_yaml::from_slice::<serde_yaml::Value>(bytes).ok();
    let current_value = current.as_deref().and_then(parse);
    let dir = history_dir(config);
    let loaded: Vec<(String, Vec<u8>)> = version_names(config)
        .into_iter()
        .filter_map(|name| fs::read(dir.join(&name)).ok().map(|content| (name, content)))
        .collect();
    let values: Vec<Option<serde_yaml::Value>> = loaded.iter().map(|(_, content)| parse(content)).collect();
    loaded
        .iter()
        .enumerate()
        .filter_map(|(index, (name, content))| {
            let saved_at = parse_name(name)?.to_rfc3339();
            // Newest first, so the version before this one is the next in the list.
            let (changes, more_changes) = match (values.get(index + 1).and_then(Option::as_ref), values[index].as_ref()) {
                (Some(previous), Some(this)) => summarize(changed_paths(previous, this)),
                _ => (Vec::new(), 0),
            };
            let (restore_changes, more_restore_changes) = match (current_value.as_ref(), values[index].as_ref()) {
                (Some(now), Some(this)) => summarize(changed_paths(now, this)),
                _ => (Vec::new(), 0),
            };
            Some(ConfigVersion {
                current: current.as_deref() == Some(content.as_slice()),
                size: content.len() as u64,
                saved_at,
                name: name.clone(),
                changes,
                more_changes,
                restore_changes,
                more_restore_changes,
            })
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
        // The last save comes three weeks later, so the earlier ones are past the 14 days and only the newest 20 stay.
        for minute in 0..25 {
            fs::write(&config, format!("v: {minute}\n")).unwrap();
            let when = if minute == 24 { at(minute) + chrono::Duration::days(21) } else { at(minute) };
            record_at(&config, when).unwrap();
        }
        fs::write(history_dir(&config).join("notes.txt"), "not a version").unwrap();
        let versions = list_at(&config);
        assert_eq!(versions.len(), KEEP);
        assert!(versions[0].name.contains("1224"), "{}", versions[0].name);
    }

    #[test]
    fn lists_changed_setting_names_but_never_values() {
        let before: serde_yaml::Value = serde_yaml::from_str("port: 8317
api-keys:
  - first-secret
oauth:
  providers:
    codex:
      response-steering: false
").unwrap();
        let after: serde_yaml::Value = serde_yaml::from_str("port: 8318
api-keys:
  - first-secret
  - second-secret
oauth:
  providers:
    codex:
      response-steering: true
").unwrap();
        let paths = changed_paths(&before, &after);
        assert_eq!(paths, vec!["api-keys", "oauth.providers.codex", "port"]);
        assert!(paths.iter().all(|path| !path.contains("secret")));
    }

    #[test]
    fn keeps_two_weeks_of_versions_beyond_the_newest_twenty() {
        let (_dir, config) = temp_config("v: 0
");
        let start = Local::now() - chrono::Duration::days(20);
        // 30 versions over the last 20 days, two thirds of a day apart.
        for step in 0..30 {
            fs::write(&config, format!("v: {}
", step + 1)).unwrap();
            record_at(&config, start + chrono::Duration::hours(16 * step)).unwrap();
        }
        let now = start + chrono::Duration::hours(16 * 29);
        let names = version_names(&config);
        assert!(names.len() > KEEP, "recent versions beyond the newest {KEEP} are kept");
        let cutoff = now - chrono::Duration::days(KEEP_DAYS);
        for name in names.iter().skip(KEEP) {
            assert!(parse_name(name).unwrap() >= cutoff, "{name} is older than {KEEP_DAYS} days and past the newest {KEEP}");
        }
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
