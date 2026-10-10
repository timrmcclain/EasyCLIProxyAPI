//! Claude Code skills and plugins.
//!
//! Plugins are managed through Claude Code's own `claude plugin` commands, so the hub never
//! edits plugin files itself. New plugins are installed switched off; the page shows what they
//! contain before the user turns them on. Skills live in `~/.claude/skills`; installing one from
//! GitHub previews its files and scripts first, and removing one sends it to the Recycle Bin.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

/// Files that can run code when a skill is used.
const SCRIPT_EXTENSIONS: &[&str] = &["py", "sh", "ps1", "psm1", "js", "mjs", "cjs", "ts", "bat", "cmd", "exe", "rb", "pl"];
/// Repositories bigger than this aren't skills; refuse rather than copy them.
const MAX_SKILL_BYTES: u64 = 50 * 1024 * 1024;
const DESCRIPTION_LIMIT: usize = 400;

fn home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

// ---------- Skills ----------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInfo {
    folder: String,
    name: String,
    description: String,
    files: usize,
    bytes: u64,
    scripts: Vec<String>,
    /// A link to a folder stored elsewhere; never removed by the hub.
    linked: bool,
    /// No SKILL.md, so Claude Code doesn't load it as a skill.
    not_a_skill: bool,
}

/// Name and description from a SKILL.md's YAML front matter.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---") else { return (None, None) };
    let Some(end) = rest.find("\n---") else { return (None, None) };
    let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&rest[..end]) else { return (None, None) };
    let field = |key: &str| yaml.get(key).and_then(|value| value.as_str()).map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "));
    (field("name"), field("description"))
}

fn shorten(text: String) -> String {
    if text.chars().count() <= DESCRIPTION_LIMIT {
        return text;
    }
    format!("{}…", text.chars().take(DESCRIPTION_LIMIT).collect::<String>().trim_end())
}

/// Files under a folder (skipping `.git`), as paths relative to it.
fn walk(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if entry.file_name() != ".git" {
                    stack.push(path);
                }
            } else if kind.is_file() {
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                found.push((path.strip_prefix(root).unwrap_or(&path).to_path_buf(), size));
            }
        }
    }
    found.sort();
    found
}

fn is_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SCRIPT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn is_link(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn describe_skill(dir: &Path) -> SkillInfo {
    let folder = dir.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
    let skill_md = fs::read_to_string(dir.join("SKILL.md")).ok();
    let (name, description) = skill_md.as_deref().map(front_matter).unwrap_or((None, None));
    let files = walk(dir);
    SkillInfo {
        name: name.unwrap_or_else(|| folder.clone()),
        description: shorten(description.unwrap_or_default()),
        files: files.len(),
        bytes: files.iter().map(|(_, size)| size).sum(),
        scripts: files.iter().filter(|(path, _)| is_script(path)).map(|(path, _)| path.to_string_lossy().replace('\\', "/")).collect(),
        linked: is_link(dir),
        not_a_skill: skill_md.is_none(),
        folder,
    }
}

fn list_skills(skills_dir: &Path) -> Vec<SkillInfo> {
    let mut skills: Vec<SkillInfo> = fs::read_dir(skills_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| describe_skill(&entry.path()))
        .collect();
    skills.sort_by(|a, b| a.folder.to_lowercase().cmp(&b.folder.to_lowercase()));
    skills
}

/// A folder name the hub is willing to create or remove under the skills folder.
fn valid_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder != "."
        && folder != ".."
        && folder.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ---------- Plugins ----------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPlugin {
    id: String,
    version: String,
    scope: String,
    enabled: bool,
    project_path: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvailablePlugin {
    id: String,
    name: String,
    description: String,
    marketplace: String,
    source_url: Option<String>,
    install_count: Option<u64>,
}

fn parse_installed(list: &Value) -> Vec<InstalledPlugin> {
    let items = list.get("installed").unwrap_or(list);
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(InstalledPlugin {
                id: item.get("id")?.as_str()?.to_string(),
                version: item.get("version").and_then(Value::as_str).unwrap_or_default().to_string(),
                scope: item.get("scope").and_then(Value::as_str).unwrap_or("user").to_string(),
                enabled: item.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                project_path: item.get("projectPath").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

fn source_url(source: Option<&Value>) -> Option<String> {
    let source = source?;
    if let Some(url) = source.as_str() {
        return Some(url.to_string());
    }
    if let Some(url) = source.get("url").and_then(Value::as_str) {
        let path = source.get("path").and_then(Value::as_str).map(|path| format!(" ({path})")).unwrap_or_default();
        return Some(format!("{url}{path}"));
    }
    source.get("repo").and_then(Value::as_str).map(|repo| format!("https://github.com/{repo}"))
}

/// Marketplace name → GitHub repository, from `~/.claude/plugins/known_marketplaces.json`.
fn marketplace_repos(known: &Value) -> std::collections::HashMap<String, String> {
    known
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| Some((name.clone(), entry.get("source")?.get("repo")?.as_str()?.to_string())))
        .collect()
}

/// A plugin stored inside its marketplace has a relative source; point it at the marketplace's repository.
fn absolute_source(url: String, marketplace: &str, repos: &std::collections::HashMap<String, String>) -> String {
    match (url.strip_prefix("./"), repos.get(marketplace)) {
        (Some(path), Some(repo)) => format!("https://github.com/{repo}/tree/HEAD/{path}"),
        _ => url,
    }
}

fn parse_available(list: &Value, repos: &std::collections::HashMap<String, String>) -> Vec<AvailablePlugin> {
    let mut plugins: Vec<AvailablePlugin> = list
        .get("available")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(AvailablePlugin {
                id: item.get("pluginId")?.as_str()?.to_string(),
                name: item.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                description: shorten(item.get("description").and_then(Value::as_str).unwrap_or_default().to_string()),
                marketplace: item.get("marketplaceName").and_then(Value::as_str).unwrap_or_default().to_string(),
                source_url: source_url(item.get("source"))
                    .map(|url| absolute_source(url, item.get("marketplaceName").and_then(Value::as_str).unwrap_or_default(), repos)),
                install_count: item.get("installCount").and_then(Value::as_u64),
            })
        })
        .collect();
    plugins.sort_by(|a, b| b.install_count.unwrap_or(0).cmp(&a.install_count.unwrap_or(0)).then(a.id.cmp(&b.id)));
    plugins
}

/// `name@marketplace`, with nothing that could be read as a command-line option.
fn valid_plugin_id(id: &str) -> bool {
    let mut parts = id.split('@');
    let (Some(name), Some(market), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    [name, market].iter().all(|part| {
        !part.is_empty() && !part.starts_with('-') && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    })
}

fn valid_scope(scope: &str) -> bool {
    matches!(scope, "user" | "project" | "local")
}

fn claude_cli(home: &Path, args: &[&str]) -> Result<String, String> {
    let claude = crate::connectors::find_claude_code(home).ok_or_else(|| "Claude Code isn't installed".to_string())?;
    let output = hidden(Command::new(&claude).args(args).current_dir(home))
        .output()
        .map_err(|error| format!("Couldn't run Claude Code: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    // Keep both streams: `--json` results arrive on stdout even when the command fails.
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err([stderr, stdout].into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("
"))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub(crate) enum InstallOutcome {
    /// Installed and switched off, with its contents for review.
    Installed { details: String },
    /// The marketplace runs a command to install it; the user must see and accept it first.
    NeedsCommandApproval { command: String, sha256: String },
}

/// The command a marketplace wants to run, from `claude plugin install --json` output.
fn shown_command(output: &str) -> Option<(String, String)> {
    output.lines().rev().find_map(|line| {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        let shown = value.get("shownCommand")?;
        let sha = shown.get("sha256")?.as_str()?.to_string();
        let command = shown
            .get("command")
            .map(|command| command.as_str().map(str::to_string).unwrap_or_else(|| command.to_string()))
            .unwrap_or_default();
        Some((command, sha))
    })
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok())
}

// ---------- Commands ----------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionsOverview {
    claude_found: bool,
    skills_dir: String,
    skills: Vec<SkillInfo>,
    plugins: Vec<InstalledPlugin>,
    available: Vec<AvailablePlugin>,
    plugin_error: Option<String>,
}

#[tauri::command]
pub(crate) async fn claude_extensions_overview(app: tauri::AppHandle) -> Result<ExtensionsOverview, String> {
    let home = home(&app)?;
    blocking(move || {
        let skills_dir = home.join(".claude/skills");
        let claude_found = crate::connectors::find_claude_code(&home).is_some();
        let (plugins, available, plugin_error) = if claude_found {
            match claude_cli(&home, &["plugin", "list", "--json", "--available"]).and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())) {
                Ok(list) => {
                    let known = read_json_file(&home.join(".claude/plugins/known_marketplaces.json")).unwrap_or(Value::Null);
                    (parse_installed(&list), parse_available(&list, &marketplace_repos(&known)), None)
                }
                Err(error) => (Vec::new(), Vec::new(), Some(error)),
            }
        } else {
            (Vec::new(), Vec::new(), None)
        };
        Ok(ExtensionsOverview {
            claude_found,
            skills: list_skills(&skills_dir),
            skills_dir: skills_dir.to_string_lossy().to_string(),
            plugins,
            available,
            plugin_error,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn claude_plugin_details(app: tauri::AppHandle, id: String) -> Result<String, String> {
    if !valid_plugin_id(&id) {
        return Err("Not a plugin id".to_string());
    }
    let home = home(&app)?;
    blocking(move || claude_cli(&home, &["plugin", "details", &id])).await
}

#[tauri::command]
pub(crate) async fn claude_plugin_install(app: tauri::AppHandle, id: String, accept_command: Option<String>) -> Result<InstallOutcome, String> {
    if !valid_plugin_id(&id) {
        return Err("Not a plugin id".to_string());
    }
    if accept_command.as_deref().is_some_and(|sha| !sha.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("Not a command fingerprint".to_string());
    }
    let home = home(&app)?;
    blocking(move || {
        let mut args = vec!["plugin", "install", id.as_str(), "--json"];
        if let Some(sha) = accept_command.as_deref() {
            args.extend(["--accept-command", sha]);
        }
        let installed = claude_cli(&home, &args);
        if let Some((command, sha256)) = shown_command(installed.as_ref().unwrap_or_else(|error| error)) {
            if installed.is_err() {
                return Ok(InstallOutcome::NeedsCommandApproval { command, sha256 });
            }
        }
        installed?;
        // Keep it off until the user has seen what it contains.
        claude_cli(&home, &["plugin", "disable", &id])?;
        let details = claude_cli(&home, &["plugin", "details", &id]).unwrap_or_default();
        Ok(InstallOutcome::Installed { details })
    })
    .await
}

#[tauri::command]
pub(crate) async fn claude_plugin_set_enabled(app: tauri::AppHandle, id: String, scope: String, enabled: bool) -> Result<(), String> {
    if !valid_plugin_id(&id) || !valid_scope(&scope) {
        return Err("Not a plugin id".to_string());
    }
    let home = home(&app)?;
    blocking(move || {
        claude_cli(&home, &["plugin", if enabled { "enable" } else { "disable" }, &id, "--scope", &scope]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub(crate) async fn claude_plugin_uninstall(app: tauri::AppHandle, id: String, scope: String) -> Result<(), String> {
    if !valid_plugin_id(&id) || !valid_scope(&scope) {
        return Err("Not a plugin id".to_string());
    }
    let home = home(&app)?;
    blocking(move || claude_cli(&home, &["plugin", "uninstall", &id, "--scope", &scope]).map(|_| ())).await
}

/// `owner/repo`, optionally with `/tree/<ref>/<path>`, from a GitHub URL or shorthand.
#[derive(Debug, PartialEq)]
struct GithubSource {
    repo: String,
    reference: Option<String>,
    path: String,
}

fn parse_github(source: &str) -> Option<GithubSource> {
    let trimmed = source.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("github.com/"))
        .unwrap_or(trimmed);
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    let safe = |part: &&str| !part.starts_with('-') && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if parts.len() < 2 || !parts[..2].iter().all(safe) || parts[..2].iter().any(|part| *part == "." || *part == "..") {
        return None;
    }
    let repo = format!("{}/{}", parts[0], parts[1]);
    match parts.get(2) {
        None => Some(GithubSource { repo, reference: None, path: String::new() }),
        Some(&"tree") | Some(&"blob") => {
            let reference = parts.get(3).copied().filter(|part| safe(&part))?.to_string();
            let path: Vec<&str> = parts[4..].to_vec();
            if path.iter().any(|part| *part == ".." || !safe(part)) {
                return None;
            }
            let mut path = path.join("/");
            if path.ends_with("SKILL.md") {
                path = path.trim_end_matches("SKILL.md").trim_end_matches('/').to_string();
            }
            Some(GithubSource { repo, reference: Some(reference), path })
        }
        _ => None,
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillCandidate {
    /// Path inside the download, used to install it.
    path: String,
    skill: SkillInfo,
    /// A skill with this folder name is already installed.
    exists: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillPreview {
    preview_id: String,
    repo: String,
    skills: Vec<SkillCandidate>,
}

static PREVIEW_COUNTER: AtomicU64 = AtomicU64::new(0);

fn preview_root() -> PathBuf {
    std::env::temp_dir().join("easycli-skill-previews")
}

/// Folders containing a SKILL.md, up to a few levels deep.
fn find_skills(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if dir.join("SKILL.md").is_file() {
            found.push(dir);
            continue;
        }
        if depth >= 4 {
            continue;
        }
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) && name != ".git" && name != "node_modules" {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    found.sort();
    found
}

#[tauri::command]
pub(crate) async fn claude_skill_preview(app: tauri::AppHandle, source: String) -> Result<SkillPreview, String> {
    let github = parse_github(&source).ok_or_else(|| "Enter a GitHub repository, like owner/repo or a github.com link".to_string())?;
    let skills_dir = home(&app)?.join(".claude/skills");
    blocking(move || {
        let id = format!("{}-{}", std::process::id(), PREVIEW_COUNTER.fetch_add(1, Ordering::Relaxed));
        let target = preview_root().join(&id);
        fs::create_dir_all(preview_root()).map_err(|error| error.to_string())?;
        let url = format!("https://github.com/{}.git", github.repo);
        let mut command = Command::new("git");
        command.args(["clone", "--depth", "1", "--quiet"]);
        if let Some(reference) = &github.reference {
            command.args(["--branch", reference]);
        }
        command.arg("--").arg(&url).arg(&target);
        let output = hidden(&mut command).output().map_err(|error| format!("Couldn't run git: {error}"))?;
        if !output.status.success() {
            let _ = fs::remove_dir_all(&target);
            return Err(format!("Couldn't download {}: {}", github.repo, String::from_utf8_lossy(&output.stderr).trim()));
        }
        let total: u64 = walk(&target).iter().map(|(_, size)| size).sum();
        if total > MAX_SKILL_BYTES {
            let _ = fs::remove_dir_all(&target);
            return Err(format!("{} is too large to be a skill ({} MB)", github.repo, total / 1024 / 1024));
        }
        let search = target.join(&github.path);
        let skills = find_skills(&search)
            .into_iter()
            .map(|dir| {
                let mut skill = describe_skill(&dir);
                // A skill at the repository root is named after the repository.
                if dir == target {
                    skill.folder = github.repo.split('/').nth(1).unwrap_or_default().to_string();
                }
                SkillCandidate {
                    path: dir.strip_prefix(&target).unwrap_or(&dir).to_string_lossy().replace('\\', "/"),
                    exists: skills_dir.join(&skill.folder).exists(),
                    skill,
                }
            })
            .collect::<Vec<_>>();
        if skills.is_empty() {
            let _ = fs::remove_dir_all(&target);
            return Err(format!("{} doesn't contain any skills (no SKILL.md found)", github.repo));
        }
        Ok(SkillPreview { preview_id: id, repo: github.repo, skills })
    })
    .await
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for (relative, _) in walk(from) {
        let target = to.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from.join(&relative), target)?;
    }
    Ok(())
}

fn install_from_preview(preview: &Path, skills_dir: &Path, path: &str, folder: &str) -> Result<(), String> {
    if !valid_folder(folder) || path.split('/').any(|part| part == "..") {
        return Err("Not a skill folder".to_string());
    }
    let from = preview.join(path);
    if !from.join("SKILL.md").is_file() || !from.starts_with(preview) {
        return Err("That skill isn't in the download".to_string());
    }
    let to = skills_dir.join(folder);
    if to.exists() {
        return Err(format!("A skill named {folder} is already installed"));
    }
    copy_dir(&from, &to).map_err(|error| {
        let _ = fs::remove_dir_all(&to);
        format!("Couldn't install {folder}: {error}")
    })
}

#[tauri::command]
pub(crate) async fn claude_skill_install(app: tauri::AppHandle, preview_id: String, path: String, folder: String) -> Result<(), String> {
    if !preview_id.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("Not a preview".to_string());
    }
    let skills_dir = home(&app)?.join(".claude/skills");
    blocking(move || install_from_preview(&preview_root().join(preview_id), &skills_dir, &path, &folder)).await
}

#[tauri::command]
pub(crate) async fn claude_skill_preview_discard(preview_id: String) -> Result<(), String> {
    if !preview_id.chars().all(|c| c.is_ascii_digit() || c == '-') || preview_id.is_empty() {
        return Err("Not a preview".to_string());
    }
    blocking(move || {
        let dir = preview_root().join(preview_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

/// Moves a folder to the Recycle Bin, so a removal can be undone from there.
fn recycle(path: &Path) -> Result<(), String> {
    let script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:EASYCLI_RECYCLE, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    let output = hidden(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).env("EASYCLI_RECYCLE", path))
        .output()
        .map_err(|error| format!("Couldn't run PowerShell: {error}"))?;
    if output.status.success() && !path.exists() {
        Ok(())
    } else {
        Err(format!("Couldn't move it to the Recycle Bin: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[tauri::command]
pub(crate) async fn claude_skill_remove(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    if !valid_folder(&folder) {
        return Err("Not a skill folder".to_string());
    }
    let skills_dir = home(&app)?.join(".claude/skills");
    blocking(move || {
        let dir = skills_dir.join(&folder);
        let skill = describe_skill(&dir);
        if !dir.is_dir() || skill.linked || skill.not_a_skill {
            return Err(format!("{folder} isn't a skill the hub can remove"));
        }
        recycle(&dir)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_front_matter_including_folded_descriptions() {
        let text = "---\nname: brainstorming\ndescription: >\n  Explore intent\n  before building.\n---\n# Body";
        assert_eq!(front_matter(text), (Some("brainstorming".into()), Some("Explore intent before building.".into())));
        assert_eq!(front_matter("# No front matter"), (None, None));
        assert_eq!(front_matter("---\ndescription: \"Quoted: yes\"\n---\n"), (None, Some("Quoted: yes".into())));
    }

    #[test]
    fn describes_skills_scripts_and_folders_that_are_not_skills() {
        let dir = std::env::temp_dir().join(format!("easycli-skill-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("demo/scripts")).unwrap();
        fs::write(dir.join("demo/SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n").unwrap();
        fs::write(dir.join("demo/scripts/run.py"), "print(1)").unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        let skills = list_skills(&dir);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "demo");
        assert_eq!(skills[0].scripts, vec!["scripts/run.py".to_string()]);
        assert!(!skills[0].not_a_skill);
        assert!(skills[1].not_a_skill);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_github_sources_and_rejects_anything_else() {
        assert_eq!(parse_github("obra/superpowers"), Some(GithubSource { repo: "obra/superpowers".into(), reference: None, path: String::new() }));
        assert_eq!(
            parse_github("https://github.com/anthropics/skills/tree/main/skills/pdf/SKILL.md"),
            Some(GithubSource { repo: "anthropics/skills".into(), reference: Some("main".into()), path: "skills/pdf".into() }),
        );
        assert_eq!(parse_github("https://github.com/a/b.git").map(|source| source.repo), Some("a/b".into()));
        for bad in ["", "justone", "https://evil.com/a/b", "a/--upload-pack=x", "a/b/tree/main/../../etc", "a/b/issues/1", "../x/y"] {
            assert_eq!(parse_github(bad), None, "{bad}");
        }
    }

    #[test]
    fn validates_plugin_ids_scopes_and_folders() {
        assert!(valid_plugin_id("superpowers@claude-plugins-official"));
        for bad in ["superpowers", "-x@y", "a@b@c", "a b@c", "a@--scope"] {
            assert!(!valid_plugin_id(bad), "{bad}");
        }
        assert!(valid_scope("project") && !valid_scope("--all"));
        assert!(valid_folder("my-skill_2.0") && !valid_folder("..") && !valid_folder("a/b") && !valid_folder(""));
    }

    #[test]
    fn parses_plugin_lists_sorted_by_popularity() {
        let list = json!({
            "installed": [{ "id": "a@m", "version": "1", "scope": "project", "enabled": false, "projectPath": "C:\\p" }],
            "available": [
                { "pluginId": "x@m", "name": "x", "description": "X", "marketplaceName": "m", "installCount": 5, "source": { "url": "https://github.com/o/r.git", "path": "plugins/x" } },
                { "pluginId": "y@m", "name": "y", "marketplaceName": "m", "installCount": 50, "source": "./plugins/y" }
            ]
        });
        assert_eq!(parse_installed(&list), vec![InstalledPlugin { id: "a@m".into(), version: "1".into(), scope: "project".into(), enabled: false, project_path: Some("C:\\p".into()) }]);
        let repos = marketplace_repos(&json!({ "m": { "source": { "source": "github", "repo": "o/market" } } }));
        let available = parse_available(&list, &repos);
        assert_eq!(available[0].source_url.as_deref(), Some("https://github.com/o/market/tree/HEAD/plugins/y"));
        assert_eq!(available.iter().map(|plugin| plugin.id.as_str()).collect::<Vec<_>>(), vec!["y@m", "x@m"]);
        assert_eq!(available[1].source_url.as_deref(), Some("https://github.com/o/r.git (plugins/x)"));
    }

    #[test]
    fn finds_a_marketplace_command_that_needs_approval() {
        let output = "something\n{\"ok\":false,\"shownCommand\":{\"command\":\"npx thing\",\"sha256\":\"abc123\"}}";
        assert_eq!(shown_command(output), Some(("npx thing".into(), "abc123".into())));
        assert_eq!(shown_command("{\"ok\":true}"), None);
    }

    #[test]
    fn installs_from_a_preview_without_overwriting() {
        let root = std::env::temp_dir().join(format!("easycli-skill-install-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let preview = root.join("preview");
        let skills = root.join("skills");
        fs::create_dir_all(preview.join("skills/demo/ref")).unwrap();
        fs::write(preview.join("skills/demo/SKILL.md"), "---\nname: demo\n---\n").unwrap();
        fs::write(preview.join("skills/demo/ref/notes.md"), "notes").unwrap();
        fs::create_dir_all(&skills).unwrap();
        install_from_preview(&preview, &skills, "skills/demo", "demo").unwrap();
        assert!(skills.join("demo/ref/notes.md").is_file());
        assert!(install_from_preview(&preview, &skills, "skills/demo", "demo").unwrap_err().contains("already installed"));
        assert!(install_from_preview(&preview, &skills, "../preview/skills/demo", "other").is_err());
        assert!(install_from_preview(&preview, &skills, "skills/demo", "..").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
