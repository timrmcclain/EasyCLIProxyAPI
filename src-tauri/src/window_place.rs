//! Where the main window was and whether it was maximised, so it opens there again.
//!
//! The size lives in the GUI config and is saved on a clean exit. Position and maximised state go in their own small
//! file, written a moment after each move or resize, because an update or a crash stops the app without that exit.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, Runtime, WebviewWindow, Window};

const FILE: &str = "window-place.json";
/// How long after the last move or resize the file is written, so dragging doesn't write on every step.
const SAVE_AFTER: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub(crate) struct WindowPlace {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) maximized: bool,
}

#[derive(Default)]
pub(crate) struct WindowPlaceState {
    current: Mutex<Option<WindowPlace>>,
    save_scheduled: AtomicBool,
}

fn path() -> Result<PathBuf, String> {
    Ok(crate::core_runtime::core_base_dir()?.join(FILE))
}

pub(crate) fn read_place() -> Option<WindowPlace> {
    let text = std::fs::read_to_string(path().ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_place(place: WindowPlace) {
    let Ok(path) = path() else { return };
    if let Ok(text) = serde_json::to_string(&place) {
        let _ = std::fs::write(path, text);
    }
}

/// A rectangle as (x, y, width, height) in physical pixels.
type Area = (i32, i32, u32, u32);

/// Whether a window whose top-left corner is at (x, y) would have its title bar on one of these screens. A monitor
/// that was unplugged must not leave the window off-screen, so a place that fits nowhere is not used.
pub(crate) fn place_fits(place: WindowPlace, screens: &[Area]) -> bool {
    // Enough of the title bar to grab: 120 px across and 30 px down from the corner.
    let (grab_x, grab_y) = (place.x.saturating_add(120), place.y.saturating_add(30));
    screens.iter().any(|&(x, y, width, height)| {
        grab_x >= x && grab_y >= y && i64::from(grab_x) < i64::from(x) + i64::from(width) && i64::from(grab_y) < i64::from(y) + i64::from(height)
    })
}

/// Records the window's current place and schedules a save. Minimised windows report a far-off position, and a
/// maximised window's position is the screen's corner, so only the maximised flag changes then.
pub(crate) fn observe<R: Runtime>(window: &Window<R>) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let state = window.state::<WindowPlaceState>();
    let Ok(mut current) = state.current.lock() else { return };
    let previous = current.unwrap_or_default();
    let next = if maximized {
        WindowPlace { maximized: true, ..previous }
    } else {
        match window.outer_position() {
            Ok(position) => WindowPlace { x: position.x, y: position.y, maximized: false },
            Err(_) => return,
        }
    };
    if *current == Some(next) {
        return;
    }
    *current = Some(next);
    drop(current);
    if state.save_scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_AFTER);
        let state = app.state::<WindowPlaceState>();
        state.save_scheduled.store(false, Ordering::Release);
        let latest = state.current.lock().ok().and_then(|place| *place);
        if let Some(place) = latest {
            write_place(place);
        }
    });
}

/// Puts the window back where it was, if that place is still on a screen.
pub(crate) fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(place) = read_place() else { return };
    let screens: Vec<Area> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (area.position.x, area.position.y, area.size.width, area.size.height)
        })
        .collect();
    if place_fits(place, &screens) {
        let _ = window.set_position(PhysicalPosition::new(place.x, place.y));
    }
    if place.maximized {
        let _ = window.maximize();
    }
    if let Ok(mut current) = window.state::<WindowPlaceState>().current.lock() {
        *current = Some(place);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREENS: [Area; 2] = [(0, 0, 1920, 1040), (1920, -200, 2560, 1400)];

    #[test]
    fn a_place_on_any_screen_is_used() {
        assert!(place_fits(WindowPlace { x: 100, y: 100, maximized: false }, &SCREENS));
        assert!(place_fits(WindowPlace { x: 2500, y: -150, maximized: false }, &SCREENS), "second screen, above the first");
        // Slightly off the left edge still leaves the title bar on screen.
        assert!(place_fits(WindowPlace { x: -60, y: 0, maximized: false }, &SCREENS));
    }

    #[test]
    fn a_place_on_an_unplugged_screen_is_not() {
        assert!(!place_fits(WindowPlace { x: 5000, y: 100, maximized: false }, &SCREENS));
        assert!(!place_fits(WindowPlace { x: 100, y: 1030, maximized: false }, &SCREENS), "title bar below the bottom edge");
        assert!(!place_fits(WindowPlace { x: 0, y: 0, maximized: false }, &[]));
        assert!(!place_fits(WindowPlace { x: i32::MAX, y: i32::MAX, maximized: false }, &SCREENS));
    }

    #[test]
    fn places_round_trip_through_json() {
        let place = WindowPlace { x: -1200, y: 40, maximized: true };
        let text = serde_json::to_string(&place).unwrap();
        assert_eq!(serde_json::from_str::<WindowPlace>(&text).unwrap(), place);
    }
}
