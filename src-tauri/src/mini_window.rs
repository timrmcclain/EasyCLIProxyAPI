//! A small always-on-top window with the hub's one-line status, opened from the tray or the command palette.
//! It shows the same summary the tray does: the main window's quota watcher sends it, and it is kept here
//! so a mini window opened later starts with the latest one.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const MINI_WINDOW_LABEL: &str = "mini";
pub(crate) const HUB_SUMMARY_EVENT: &str = "hub-summary";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubSummary {
    menu_text: String,
    tooltip_text: String,
    level: Option<String>,
}

static LAST_SUMMARY: Mutex<Option<HubSummary>> = Mutex::new(None);

/// Keeps the newest tray summary and passes it to the mini window when one is open.
pub(crate) fn remember_summary(app: &tauri::AppHandle, menu_text: &str, tooltip_text: &str, level: Option<&str>) {
    let summary = HubSummary { menu_text: menu_text.to_string(), tooltip_text: tooltip_text.to_string(), level: level.map(str::to_string) };
    if let Ok(mut last) = LAST_SUMMARY.lock() {
        *last = Some(summary.clone());
    }
    if app.get_webview_window(MINI_WINDOW_LABEL).is_some() {
        let _ = app.emit_to(MINI_WINDOW_LABEL, HUB_SUMMARY_EVENT, summary);
    }
}

#[tauri::command]
pub(crate) fn get_hub_summary() -> Option<HubSummary> {
    LAST_SUMMARY.lock().ok().and_then(|last| last.clone())
}

pub(crate) fn show_mini_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, MINI_WINDOW_LABEL, WebviewUrl::default())
        // The page reads this before rendering and shows the mini view instead of the whole app.
        .initialization_script("window.__HUB_MINI__ = true;")
        .title("Tim’s AI Hub")
        .inner_size(340.0, 150.0)
        .min_inner_size(260.0, 120.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn open_mini_window(app: tauri::AppHandle) -> Result<(), String> {
    show_mini_window(&app)
}

/// The mini window's "Open the hub" button.
#[tauri::command]
pub(crate) fn show_main_from_mini(app: tauri::AppHandle) {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    crate::tray::show_windows_main_window(&app);
    #[cfg(target_os = "macos")]
    crate::tray::show_main_window(&app);
}
