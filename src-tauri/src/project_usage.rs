//! Usage by project, read from Claude Code's own session logs.
//!
//! The proxy doesn't know which project a request came from, but every assistant
//! message Claude Code logs under `~/.claude/projects` carries its working folder,
//! session and token use. The logs are large (gigabytes of tool output), so the
//! hub reads them once, keeps a compact cache of per-message totals, and after
//! that only reads lines appended since the last look. Messages copied into a
//! resumed session are counted once, keyed by message and request id.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const CACHE_VERSION: u32 = 1;
const CACHE_FILE: &str = "claude-project-usage.json";
/// Longest window the page offers; older files and messages are dropped from the cache.
const MAX_DAYS: u64 = 30;

/// One assistant message's token use: [key, project, session, unix seconds, input, output, cache read, cache write].
type Message = (u64, u32, u32, i64, u64, u64, u64, u64);

#[derive(Serialize, Deserialize, Default)]
struct CachedFile {
    modified_ms: u64,
    /// Bytes read so far, always at the end of a complete line.
    offset: u64,
    projects: Vec<String>,
    sessions: Vec<String>,
    messages: Vec<Message>,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<String, CachedFile>,
}

static SCAN: Mutex<()> = Mutex::new(());

/// FNV-1a, so dedupe keys stay the same across hub versions (std's hasher makes no such promise).
fn stable_key(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

fn index_of(list: &mut Vec<String>, value: &str) -> u32 {
    match list.iter().position(|item| item == value) {
        Some(index) => index as u32,
        None => {
            list.push(value.to_string());
            (list.len() - 1) as u32
        }
    }
}

/// Parses one log line; only assistant messages with token use count.
fn parse_line(line: &str, file: &mut CachedFile) {
    // Most lines are tool output; skip them before paying for a JSON parse.
    if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return };
    if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return;
    }
    let Some(message) = value.get("message") else { return };
    let Some(usage) = message.get("usage") else { return };
    let number = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    let (input, output, read, write) = (
        number("input_tokens"),
        number("output_tokens"),
        number("cache_read_input_tokens"),
        number("cache_creation_input_tokens"),
    );
    if input + output + read + write == 0 {
        return;
    }
    let Some(seconds) = value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.timestamp())
    else {
        return;
    };
    let id = message.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let request = value.get("requestId").and_then(|v| v.as_str()).unwrap_or_default();
    let key = if id.is_empty() && request.is_empty() {
        stable_key(line)
    } else {
        stable_key(&format!("{id}:{request}"))
    };
    let cwd = value.get("cwd").and_then(|v| v.as_str()).unwrap_or_default();
    let session = value.get("sessionId").and_then(|v| v.as_str()).unwrap_or_default();
    let project = index_of(&mut file.projects, cwd);
    let session = index_of(&mut file.sessions, session);
    file.messages.push((key, project, session, seconds, input, output, read, write));
}

/// Reads complete lines from `offset` on; a half-written last line is left for next time.
fn read_from(path: &Path, file: &mut CachedFile) -> std::io::Result<()> {
    let mut handle = File::open(path)?;
    handle.seek(SeekFrom::Start(file.offset))?;
    let mut reader = BufReader::with_capacity(1 << 20, handle);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 || buffer.last() != Some(&b'\n') {
            break;
        }
        file.offset += read as u64;
        parse_line(&String::from_utf8_lossy(&buffer), file);
    }
    Ok(())
}

fn log_files(root: &Path, cutoff: SystemTime, found: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            log_files(&path, cutoff, found);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            let modified = meta.modified().unwrap_or(UNIX_EPOCH);
            if modified >= cutoff {
                let ms = modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                found.push((path, ms, meta.len()));
            }
        }
    }
}

/// Brings the cache up to date with the logs under `root`. Returns how many files were (re)read.
fn refresh(root: &Path, cache: &mut Cache, now: SystemTime) -> usize {
    let cutoff = now - Duration::from_secs(MAX_DAYS * 86_400);
    let mut found = Vec::new();
    log_files(root, cutoff, &mut found);
    let live: HashSet<String> = found.iter().map(|(path, _, _)| path.to_string_lossy().into_owned()).collect();
    cache.files.retain(|path, _| live.contains(path));
    let mut read = 0;
    for (path, modified_ms, size) in found {
        let key = path.to_string_lossy().into_owned();
        let entry = cache.files.entry(key).or_default();
        if entry.modified_ms == modified_ms && entry.offset <= size {
            continue;
        }
        // A file that shrank was rewritten; start it over. Otherwise read only what was appended.
        if size < entry.offset {
            *entry = CachedFile::default();
        }
        if read_from(&path, entry).is_ok() {
            entry.modified_ms = modified_ms;
            read += 1;
        }
    }
    let oldest = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - (MAX_DAYS * 86_400) as i64;
    for file in cache.files.values_mut() {
        file.messages.retain(|message| message.3 >= oldest);
    }
    read
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectUsage {
    path: String,
    sessions: usize,
    messages: usize,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    last_active: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectUsageReport {
    projects: Vec<ProjectUsage>,
    days: u64,
    files_read: usize,
    found: bool,
}

/// Totals per project since `since` (unix seconds), counting each message once, biggest first.
fn summarize(cache: &Cache, since: i64) -> Vec<ProjectUsage> {
    // Claude Code logs a reply once per content block as it streams, and the token counts grow between copies
    // (the first often has only a few output tokens). Keep the largest of each count, not the first copy.
    struct Message { path: String, session: String, seconds: i64, counts: [u64; 4] }
    let mut messages: HashMap<u64, Message> = HashMap::new();
    for file in cache.files.values() {
        for &(key, project, session, seconds, input, output, read, write) in &file.messages {
            let counts = [input, output, read, write];
            match messages.get_mut(&key) {
                Some(message) => {
                    for (kept, count) in message.counts.iter_mut().zip(counts) {
                        *kept = (*kept).max(count);
                    }
                    message.seconds = message.seconds.min(seconds);
                }
                None => {
                    let path = file.projects.get(project as usize).cloned().unwrap_or_default();
                    let session = file.sessions.get(session as usize).cloned().unwrap_or_default();
                    messages.insert(key, Message { path, session, seconds, counts });
                }
            }
        }
    }
    let mut totals: HashMap<String, (HashSet<String>, ProjectUsage)> = HashMap::new();
    for Message { path, session, seconds, counts: [input, output, read, write] } in messages.into_values() {
        if seconds < since {
            continue;
        }
        let (sessions, usage) = totals.entry(path.clone()).or_insert_with(|| {
            (HashSet::new(), ProjectUsage { path, sessions: 0, messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, last_active: 0 })
        });
        sessions.insert(session);
        usage.messages += 1;
        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cache_read_tokens += read;
        usage.cache_write_tokens += write;
        usage.last_active = usage.last_active.max(seconds);
    }
    let mut projects: Vec<ProjectUsage> = totals
        .into_values()
        .map(|(sessions, mut usage)| {
            usage.sessions = sessions.len();
            usage
        })
        .collect();
    let weight = |usage: &ProjectUsage| usage.input_tokens + usage.output_tokens + usage.cache_write_tokens;
    projects.sort_by(|a, b| weight(b).cmp(&weight(a)).then_with(|| a.path.cmp(&b.path)));
    projects
}

fn load_cache(path: &Path) -> Cache {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Cache>(&text).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .unwrap_or(Cache { version: CACHE_VERSION, files: HashMap::new() })
}

fn report(root: &Path, cache_path: &Path, days: u64) -> ProjectUsageReport {
    let _guard = SCAN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !root.is_dir() {
        return ProjectUsageReport { projects: Vec::new(), days, files_read: 0, found: false };
    }
    let mut cache = load_cache(cache_path);
    let now = SystemTime::now();
    let files_read = refresh(root, &mut cache, now);
    if files_read > 0 {
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(&cache) {
            let _ = fs::write(cache_path, text);
        }
    }
    let days = days.clamp(1, MAX_DAYS);
    let since = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - (days * 86_400) as i64;
    ProjectUsageReport { projects: summarize(&cache, since), days, files_read, found: true }
}

/// The first call reads up to 30 days of logs (it can take a minute); later calls only read what's new.
#[tauri::command]
pub(crate) async fn claude_project_usage(app: tauri::AppHandle, days: u64) -> Result<ProjectUsageReport, String> {
    let home = app.path().home_dir().map_err(|error| format!("Failed to get user directory: {error}"))?;
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Local"));
    let root = home.join(".claude/projects");
    let cache_path = local.join("TimAIHub").join(CACHE_FILE);
    // One read at a time: a second request waits and then finds the cache already warm.
    static READING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = READING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        report(&root, &cache_path, days)
    })
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(id: &str, request: &str, cwd: &str, session: &str, time: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","cwd":"{cwd}","sessionId":"{session}","requestId":"{request}","timestamp":"{time}","message":{{"id":"{id}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":100,"cache_creation_input_tokens":10}}}}}}"#
        )
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hub-project-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("proj-a/sub")).unwrap();
        root
    }

    #[test]
    fn totals_per_project_count_resumed_copies_once_and_skip_tool_output() {
        let root = temp_root("totals");
        let now = chrono::Utc::now();
        let recent = (now - chrono::Duration::hours(2)).to_rfc3339();
        let old = (now - chrono::Duration::days(10)).to_rfc3339();
        let first = [
            line("m1", "r1", "C:/work/app", "s1", &recent, 10, 5),
            r#"{"type":"user","message":{"content":"a huge tool result with \"usage\" in it"}}"#.to_string(),
            line("m2", "r2", "C:/work/app", "s1", &old, 1, 1),
            line("m3", "r3", "C:/work/other", "s2", &recent, 3, 3),
        ]
        .join("\n") + "\n";
        fs::write(root.join("proj-a/one.jsonl"), first).unwrap();
        // A resumed session repeats m1 in a new file; it must not count twice.
        fs::write(root.join("proj-a/sub/two.jsonl"), line("m1", "r1", "C:/work/app", "s3", &recent, 10, 5) + "\n").unwrap();

        let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
        assert_eq!(refresh(&root, &mut cache, SystemTime::now()), 2);
        let since = (now - chrono::Duration::days(7)).timestamp();
        let projects = summarize(&cache, since);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "C:/work/app");
        assert_eq!((projects[0].messages, projects[0].input_tokens, projects[0].output_tokens), (1, 10, 5));
        assert_eq!((projects[0].cache_read_tokens, projects[0].cache_write_tokens), (100, 10));
        assert_eq!(projects[1].path, "C:/work/other");
        // The 10-day-old message shows up in a 30-day window.
        let month = summarize(&cache, (now - chrono::Duration::days(30)).timestamp());
        assert_eq!(month[0].messages, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_streamed_reply_counts_once_with_its_final_token_counts() {
        let root = temp_root("streamed");
        let recent = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        // Claude Code writes one line per content block; output grows from 2 to 480 across the copies.
        let copies = [
            line("m1", "r1", "C:/work/app", "s1", &recent, 10, 2),
            line("m1", "r1", "C:/work/app", "s1", &recent, 10, 120),
            line("m1", "r1", "C:/work/app", "s1", &recent, 10, 480),
        ]
        .join("\n") + "\n";
        fs::write(root.join("proj-a/one.jsonl"), copies).unwrap();

        let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
        refresh(&root, &mut cache, SystemTime::now());
        let projects = summarize(&cache, 0);
        assert_eq!((projects[0].messages, projects[0].input_tokens, projects[0].output_tokens), (1, 10, 480));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_appended_lines_are_read_and_a_half_written_line_waits() {
        let root = temp_root("append");
        let time = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let path = root.join("proj-a/live.jsonl");
        fs::write(&path, line("a", "1", "C:/p", "s", &time, 1, 1) + "\n" + &line("b", "2", "C:/p", "s", &time, 1, 1)[..40]).unwrap();
        let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
        refresh(&root, &mut cache, SystemTime::now());
        assert_eq!(summarize(&cache, 0)[0].messages, 1, "the unfinished line is not counted yet");

        // Finish the line and add another; make sure the modified time moves.
        std::thread::sleep(Duration::from_millis(20));
        let mut handle = fs::OpenOptions::new().append(true).open(&path).unwrap();
        let rest = &line("b", "2", "C:/p", "s", &time, 1, 1)[40..];
        write!(handle, "{rest}\n{}\n", line("c", "3", "C:/p", "s", &time, 1, 1)).unwrap();
        drop(handle);
        let later = SystemTime::now() + Duration::from_secs(1);
        let reread = refresh(&root, &mut cache, later);
        assert_eq!(reread, 1);
        assert_eq!(summarize(&cache, 0)[0].messages, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dedupe_keys_are_stable() {
        assert_eq!(stable_key("msg_1:req_1"), stable_key("msg_1:req_1"));
        assert_ne!(stable_key("msg_1:req_1"), stable_key("msg_1:req_2"));
        assert_eq!(stable_key(""), 0xcbf2_9ce4_8422_2325);
    }
}

