//! Secret Guard: installs the bundled proxy plugin (see `secret-guard/`) into the proxy's plugins folder and reads
//! what it found. The plugin itself scans each outgoing request; switching it on, its policy and its allowlist go
//! through the proxy's management API from the frontend. Findings never contain a secret, only its kind and a
//! salted fingerprint, so nothing here needs protecting beyond the proxy folder it sits in.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{core_install_dir, CORE_CONFIG_FILE};

const PLUGIN_ID: &str = "secret-guard";
/// Findings files over this size are trimmed to their newest lines.
const MAX_FINDINGS_BYTES: u64 = 4 * 1024 * 1024;
const KEEP_LINES: usize = 20_000;

#[cfg(secret_guard_bundled)]
static PLUGIN_LIBRARY: &[u8] = include_bytes!(env!("SECRET_GUARD_DLL"));
#[cfg(not(secret_guard_bundled))]
static PLUGIN_LIBRARY: &[u8] = &[];
#[cfg(secret_guard_bundled)]
const BUNDLED_VERSION: &str = env!("SECRET_GUARD_VERSION");
#[cfg(not(secret_guard_bundled))]
const BUNDLED_VERSION: &str = "";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretGuardInfo {
    bundled: bool,
    bundled_version: String,
    installed: bool,
    findings_file: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretGuardInstall {
    findings_file: String,
    /// An older copy was loaded by the running proxy; the new one takes over after the proxy restarts.
    replaced_loaded_copy: bool,
}

#[derive(Debug, Deserialize)]
struct FindingLine {
    #[serde(default)]
    ts: u64,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    fingerprint: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    client: String,
    #[serde(default)]
    action: String,
}

/// Everything known about one secret, across every request it appeared in.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretGuardFinding {
    fingerprint: String,
    kind: String,
    first_seen: u64,
    last_seen: u64,
    /// Log entries; the plugin logs a secret again at most every 15 minutes per provider and action.
    sightings: usize,
    providers: Vec<String>,
    models: Vec<String>,
    clients: Vec<String>,
    actions: Vec<String>,
    /// When the user said they rotated it. Hidden until it's seen again after that.
    dismissed_at: Option<u64>,
}

fn guard_dir() -> Result<PathBuf, String> {
    Ok(core_install_dir()?.join(PLUGIN_ID))
}

fn findings_path() -> Result<PathBuf, String> {
    Ok(guard_dir()?.join("findings.jsonl"))
}

fn dismissed_path() -> Result<PathBuf, String> {
    Ok(guard_dir()?.join("dismissed.json"))
}

/// Mirrors the proxy's ResolvePluginsDir: `~` is the home folder, relative paths are relative to the proxy's
/// working directory, which the hub sets to the core install folder.
fn resolve_plugins_dir(configured: &str, core_dir: &Path, home: Option<PathBuf>) -> PathBuf {
    let configured = configured.trim();
    let configured = if configured.is_empty() { "plugins" } else { configured };
    if let Some(rest) = configured.strip_prefix('~') {
        let rest = rest.trim_start_matches(['/', '\\']);
        if let Some(home) = home {
            return if rest.is_empty() { home } else { home.join(rest) };
        }
    }
    let path = PathBuf::from(configured);
    if path.is_absolute() {
        path
    } else {
        core_dir.join(path)
    }
}

fn configured_plugins_dir(core_dir: &Path) -> String {
    let text = fs::read_to_string(core_dir.join(CORE_CONFIG_FILE)).unwrap_or_default();
    serde_yaml::from_str::<serde_yaml::Value>(&text)
        .ok()
        .and_then(|config| config.get("plugins")?.get("dir")?.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The proxy looks in `<plugins>/<os>/<arch>/` first, named with Go's OS and architecture names.
fn plugin_file(plugins_dir: &Path) -> PathBuf {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    let (os, extension) = match std::env::consts::OS {
        "windows" => ("windows", "dll"),
        "macos" => ("darwin", "dylib"),
        other => (other, "so"),
    };
    plugins_dir.join(os).join(arch).join(format!("{PLUGIN_ID}.{extension}"))
}

fn installed_plugin_file() -> Result<PathBuf, String> {
    let core_dir = core_install_dir()?;
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    Ok(plugin_file(&resolve_plugins_dir(&configured_plugins_dir(&core_dir), &core_dir, home)))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub(crate) fn secret_guard_info() -> Result<SecretGuardInfo, String> {
    Ok(SecretGuardInfo {
        bundled: !PLUGIN_LIBRARY.is_empty(),
        bundled_version: BUNDLED_VERSION.to_string(),
        installed: installed_plugin_file()?.is_file(),
        findings_file: display(&findings_path()?),
    })
}

/// Copies the bundled plugin into the proxy's plugins folder. The proxy loads it the next time its plugin settings
/// change, which the frontend does right after this.
#[tauri::command]
pub(crate) fn secret_guard_install() -> Result<SecretGuardInstall, String> {
    if PLUGIN_LIBRARY.is_empty() {
        return Err("This build of the hub doesn't include Secret Guard.".to_string());
    }
    fs::create_dir_all(guard_dir()?).map_err(|err| format!("Couldn't create the Secret Guard folder: {err}"))?;
    let replaced_loaded_copy = install_library(&installed_plugin_file()?, PLUGIN_LIBRARY)?;
    Ok(SecretGuardInstall { findings_file: display(&findings_path()?), replaced_loaded_copy })
}

/// Writes `library` to `target` unless it's already there. A loaded DLL can't be overwritten on Windows but can be
/// renamed, so an older copy is moved aside first. Returns whether an older copy was replaced.
fn install_library(target: &Path, library: &[u8]) -> Result<bool, String> {
    let dir = target.parent().ok_or("Invalid plugins folder")?;
    fs::create_dir_all(dir).map_err(|err| format!("Couldn't create {}: {err}", display(dir)))?;
    // Old copies from earlier updates, once the proxy has let go of them.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&format!("{PLUGIN_ID}.old-")) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let replaced = match fs::read(target) {
        Ok(existing) if existing == library => return Ok(false),
        Ok(_) => {
            let aside = dir.join(format!("{PLUGIN_ID}.old-{}", chrono::Local::now().format("%Y%m%d%H%M%S")));
            fs::rename(target, &aside).map_err(|err| format!("Couldn't move the old Secret Guard aside: {err}"))?;
            true
        }
        Err(_) => false,
    };
    let temp = dir.join(format!("{PLUGIN_ID}.tmp"));
    fs::write(&temp, library).map_err(|err| format!("Couldn't write Secret Guard: {err}"))?;
    fs::rename(&temp, target).map_err(|err| format!("Couldn't install Secret Guard: {err}"))?;
    Ok(replaced)
}

fn read_dismissed(path: &Path) -> BTreeMap<String, u64> {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Keeps the findings file bounded. The plugin appends with short-lived opens, so a line written during the rewrite
/// can be lost; that only drops a repeat sighting, since first sightings are long since read by then.
fn trim_findings(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_FINDINGS_BYTES {
        return;
    }
    let Ok(text) = fs::read_to_string(path) else { return };
    let lines: Vec<&str> = text.lines().collect();
    let keep = lines[lines.len().saturating_sub(KEEP_LINES)..].join("\n") + "\n";
    let temp = path.with_extension("jsonl.tmp");
    if fs::write(&temp, keep).is_ok() {
        let _ = fs::rename(&temp, path);
    }
}

fn group_findings(text: &str, dismissed: &BTreeMap<String, u64>) -> Vec<SecretGuardFinding> {
    #[derive(Default)]
    struct Group {
        kind: String,
        first: u64,
        last: u64,
        sightings: usize,
        providers: BTreeSet<String>,
        models: BTreeSet<String>,
        clients: BTreeSet<String>,
        actions: BTreeSet<String>,
    }
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<FindingLine>(line) else { continue };
        if entry.fingerprint.is_empty() {
            continue;
        }
        let group = groups.entry(entry.fingerprint.clone()).or_default();
        if group.sightings == 0 || entry.ts < group.first {
            group.first = entry.ts;
        }
        group.last = group.last.max(entry.ts);
        group.sightings += 1;
        group.kind = entry.kind;
        for (set, value) in [(&mut group.providers, entry.provider), (&mut group.models, entry.model), (&mut group.clients, entry.client), (&mut group.actions, entry.action)] {
            if !value.is_empty() {
                set.insert(value);
            }
        }
    }
    let mut out: Vec<SecretGuardFinding> = groups
        .into_iter()
        .map(|(fingerprint, g)| SecretGuardFinding {
            dismissed_at: dismissed.get(&fingerprint).copied().filter(|at| *at >= g.last),
            fingerprint,
            kind: g.kind,
            first_seen: g.first,
            last_seen: g.last,
            sightings: g.sightings,
            providers: g.providers.into_iter().collect(),
            models: g.models.into_iter().collect(),
            clients: g.clients.into_iter().collect(),
            actions: g.actions.into_iter().collect(),
        })
        .collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out
}

#[tauri::command]
pub(crate) fn secret_guard_findings() -> Result<Vec<SecretGuardFinding>, String> {
    let path = findings_path()?;
    trim_findings(&path);
    let text = fs::read_to_string(&path).unwrap_or_default();
    Ok(group_findings(&text, &read_dismissed(&dismissed_path()?)))
}

/// Marks a finding as handled ("I've rotated it"), or clears that mark.
#[tauri::command]
pub(crate) fn secret_guard_dismiss(fingerprint: String, dismissed: bool) -> Result<(), String> {
    let fingerprint = fingerprint.trim().to_ascii_lowercase();
    if fingerprint.len() != 8 || !fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid fingerprint".to_string());
    }
    let path = dismissed_path()?;
    let mut map = read_dismissed(&path);
    if dismissed {
        map.insert(fingerprint, chrono::Utc::now().timestamp_millis().max(0) as u64);
    } else {
        map.remove(&fingerprint);
    }
    fs::create_dir_all(guard_dir()?).map_err(|err| err.to_string())?;
    let text = serde_json::to_string_pretty(&map).map_err(|err| err.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text).map_err(|err| err.to_string())?;
    fs::rename(&temp, &path).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("hub-secret-guard-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn plugins_dir_resolves_like_the_proxy() {
        let core = Path::new("C:/hub/cpa-core");
        assert_eq!(resolve_plugins_dir("", core, None), core.join("plugins"));
        assert_eq!(resolve_plugins_dir("plugins", core, None), core.join("plugins"));
        assert_eq!(resolve_plugins_dir("~/cpa-plugins", core, Some(PathBuf::from("C:/Users/me"))), PathBuf::from("C:/Users/me").join("cpa-plugins"));
        let file = plugin_file(&core.join("plugins"));
        assert!(file.to_string_lossy().contains("secret-guard."));
    }

    #[test]
    fn install_skips_identical_copies_and_moves_old_ones_aside() {
        let dir = temp_dir();
        let target = dir.join("windows").join("amd64").join("secret-guard.dll");
        assert!(!install_library(&target, b"v1").unwrap(), "fresh install");
        assert_eq!(fs::read(&target).unwrap(), b"v1");
        assert!(!install_library(&target, b"v1").unwrap(), "same bytes: nothing to do");
        assert!(install_library(&target, b"v2").unwrap(), "an older copy was replaced");
        assert_eq!(fs::read(&target).unwrap(), b"v2");
        let names: Vec<String> = fs::read_dir(target.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().any(|n| n.starts_with("secret-guard.old-")), "{names:?}");
        assert!(!names.iter().any(|n| n.ends_with(".tmp")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn findings_group_by_secret_and_respect_dismissals() {
        let text = [
            r#"{"ts":100,"kind":"github_token","fingerprint":"aaaa0001","provider":"anthropic","model":"sonnet","client":"claude-cli/2.1","action":"reported"}"#,
            r#"{"ts":300,"kind":"github_token","fingerprint":"aaaa0001","provider":"openai","model":"gpt-6","client":"codex/1.0","action":"redacted"}"#,
            r#"{"ts":200,"kind":"jwt","fingerprint":"bbbb0002","provider":"anthropic","model":"opus","client":"claude-cli/2.1 (claude-desktop-3p)","action":"reported"}"#,
            "not json",
        ]
        .join("\n");
        let mut dismissed = BTreeMap::new();
        dismissed.insert("bbbb0002".to_string(), 250); // rotated after its last sighting: stays hidden
        dismissed.insert("aaaa0001".to_string(), 150); // seen again after the dismissal: shows again
        let groups = group_findings(&text, &dismissed);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].fingerprint, "aaaa0001", "newest first");
        assert_eq!((groups[0].first_seen, groups[0].last_seen, groups[0].sightings), (100, 300, 2));
        assert_eq!(groups[0].providers, vec!["anthropic", "openai"]);
        assert_eq!(groups[0].actions, vec!["redacted", "reported"]);
        assert_eq!(groups[0].dismissed_at, None);
        assert_eq!(groups[1].dismissed_at, Some(250));
    }

    #[test]
    fn oversized_findings_files_keep_their_newest_lines() {
        let dir = temp_dir();
        let path = dir.join("findings.jsonl");
        let line = format!("{{\"ts\":1,\"fingerprint\":\"cccc0003\",\"pad\":\"{}\"}}\n", "x".repeat(300));
        fs::write(&path, line.repeat(KEEP_LINES + 500)).unwrap();
        trim_findings(&path);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), KEEP_LINES);
        let _ = fs::remove_dir_all(dir);
    }
}
