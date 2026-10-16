//! The end of the proxy's console log, for the in-app viewer. The file grows to tens of MB, so only its tail is
//! read. Key- and token-shaped text is masked before it leaves the backend; emails are left for the page to hide,
//! since that follows the user's Hide emails setting.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::core_runtime::core_start_log_path;
use crate::{core_install_dir, GuiConfigState};

/// Most of the file read per request; enough for a few thousand lines.
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_LINES: usize = 2000;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreLogTail {
    lines: Vec<String>,
    /// Where the file is, for the Open folder link.
    path: String,
    /// The file is longer than what was read.
    truncated: bool,
    exists: bool,
}

fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}",
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{10,}",
            r"\bgh[pousr]_[A-Za-z0-9]{20,}",
            r"\bgithub_pat_[A-Za-z0-9_]{20,}",
            r"\bAIza[0-9A-Za-z_-]{30,}",
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}",
            r#"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}"#,
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("valid pattern"))
        .collect()
    })
}

/// Replaces anything key-shaped with [hidden], keeping the name in `key=value` pairs so the line still reads.
pub(crate) fn mask_secrets(line: &str) -> String {
    let patterns = secret_patterns();
    let mut out = line.to_string();
    for (index, pattern) in patterns.iter().enumerate() {
        out = if index == patterns.len() - 1 {
            pattern.replace_all(&out, "$1$2[hidden]").into_owned()
        } else {
            pattern.replace_all(&out, "[hidden]").into_owned()
        };
    }
    out
}

pub(crate) fn read_tail(path: &Path, limit: usize) -> Result<CoreLogTail, String> {
    let display = path.to_string_lossy().into_owned();
    let Ok(mut file) = File::open(path) else {
        return Ok(CoreLogTail { lines: Vec::new(), path: display, truncated: false, exists: false });
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = size.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start)).map_err(|error| format!("Couldn't read the proxy log: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| format!("Couldn't read the proxy log: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    // Reading from the middle of the file starts mid-line; drop that partial line.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let limit = limit.clamp(1, MAX_LINES);
    let truncated = start > 0 || lines.len() > limit;
    let skip = lines.len().saturating_sub(limit);
    Ok(CoreLogTail {
        lines: lines.into_iter().skip(skip).filter(|line| !line.trim().is_empty()).map(mask_secrets).collect(),
        path: display,
        truncated,
        exists: true,
    })
}

#[tauri::command]
pub(crate) fn read_core_log(gui_config_state: tauri::State<'_, GuiConfigState>, limit: Option<usize>) -> Result<CoreLogTail, String> {
    let config = gui_config_state.snapshot()?;
    let path = core_start_log_path(&core_install_dir()?, &config.auth_dir)?;
    read_tail(&path, limit.unwrap_or(500))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn masks_key_shaped_text_but_keeps_the_line_readable() {
        let key = format!("sk-{}", "a1b2c3d4e5f6g7h8");
        let line = format!("[info ] upstream ok key {key} Authorization: Bearer abcdefghijkl12345 api_key=xyz123456 for someone@example.com");
        let masked = mask_secrets(&line);
        assert!(!masked.contains(&key));
        assert!(!masked.contains("abcdefghijkl12345"));
        assert!(!masked.contains("xyz123456"));
        assert!(masked.contains("api_key=[hidden]"), "{masked}");
        assert!(masked.contains("someone@example.com"), "emails are left for the page to hide");
        assert_eq!(mask_secrets("[info ] 200 | 1.2s | POST /v1/messages"), "[info ] 200 | 1.2s | POST /v1/messages");
    }

    #[test]
    fn reads_only_the_tail_of_a_large_file_and_drops_the_partial_first_line() {
        let dir = std::env::temp_dir().join(format!("cpa-core-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("core-start-output.log");
        let mut file = File::create(&path).unwrap();
        // About 1.5 MB: more than one read's worth.
        for index in 0..30_000 {
            writeln!(file, "[info ] line {index:05} padding-padding-padding-padding").unwrap();
        }
        drop(file);
        let tail = read_tail(&path, 100).unwrap();
        assert!(tail.exists && tail.truncated);
        assert_eq!(tail.lines.len(), 100);
        assert!(tail.lines.last().unwrap().contains("line 29999"));
        assert!(tail.lines.iter().all(|line| line.starts_with("[info ]")), "no partial lines");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_log_is_reported_not_an_error() {
        let tail = read_tail(Path::new("C:/definitely/not/here/core-start-output.log"), 10).unwrap();
        assert!(!tail.exists);
        assert!(tail.lines.is_empty());
    }
}
