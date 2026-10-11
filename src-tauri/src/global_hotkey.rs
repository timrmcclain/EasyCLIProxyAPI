//! An optional system-wide shortcut that brings the hub to the front, like clicking the tray icon.
//! The shortcut is fixed here, so the window can only switch it on or off, never register others.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn hub_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyH)
}

pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed && *shortcut == hub_shortcut() {
                #[cfg(target_os = "macos")]
                crate::tray::show_main_window(app);
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                crate::tray::show_windows_main_window(app);
            }
        })
        .build()
}

/// Switches the shortcut on or off. Fails, leaving it off, when another app already owns it.
#[tauri::command]
pub(crate) fn set_global_hotkey(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let shortcuts = app.global_shortcut();
    let shortcut = hub_shortcut();
    let registered = shortcuts.is_registered(shortcut);
    if enabled && !registered {
        shortcuts
            .register(shortcut)
            .map_err(|error| format!("Ctrl+Alt+H couldn't be claimed; another app may already use it ({error})"))?;
    } else if !enabled && registered {
        shortcuts.unregister(shortcut).map_err(|error| error.to_string())?;
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_is_ctrl_alt_h() {
        let shortcut = hub_shortcut();
        assert!(shortcut.mods.contains(Modifiers::CONTROL | Modifiers::ALT));
        assert_eq!(shortcut.key, Code::KeyH);
    }
}
