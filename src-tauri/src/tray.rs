use super::*;
use crate::native_i18n::{native_operation_failed, native_text, NativeText};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSStatusItemBehavior;
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;

#[cfg(target_os = "macos")]
const MACOS_TRAY_ID: &str = "macos-tray";

#[cfg(target_os = "macos")]
#[derive(Default)]
pub(crate) struct MacosTrayClickState {
    last_click: Option<Instant>,
    sequence: u64,
}

#[cfg(target_os = "macos")]
pub(crate) fn set_macos_dock_visible(app_handle: &tauri::AppHandle, visible: bool) {
    if let Err(error) = app_handle.set_dock_visibility(visible) {
        eprintln!("Failed to update Dock icon visibility: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_main_window_on_main_thread(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    set_macos_dock_visible(app_handle, true);
    if let Err(error) = window.show() {
        eprintln!("Failed to show the main window: {error}");
        set_macos_dock_visible(app_handle, false);
        return;
    }
    if window.is_minimized().unwrap_or(false) {
        if let Err(error) = window.unminimize() {
            eprintln!("Failed to restore the main window: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        eprintln!("Failed to focus the main window: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_main_window(app_handle: &tauri::AppHandle) {
    if MainThreadMarker::new().is_some() {
        show_main_window_on_main_thread(app_handle);
        return;
    }

    let app_handle = app_handle.clone();
    if let Err(error) = app_handle.clone().run_on_main_thread(move || {
        show_main_window_on_main_thread(&app_handle);
    }) {
        eprintln!("Failed to schedule showing the main window: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_macos_tray_menu<R: tauri::Runtime>(tray: &TrayIcon<R>) {
    let result = tray.with_inner_tray_icon(|tray_icon| {
        let Some(status_item) = tray_icon.ns_status_item() else {
            return;
        };
        let mtm = MainThreadMarker::new().expect("tray menu must be shown on the main thread");
        if let Some(menu) = status_item.menu(mtm) {
            #[allow(deprecated)]
            status_item.popUpStatusItemMenu(&menu);
        }
    });

    if let Err(error) = result {
        eprintln!("Failed to show the tray menu: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn setup_macos_tray(app: &mut tauri::App<tauri::Wry>) -> tauri::Result<()> {
    let locale = app
        .state::<GuiConfigState>()
        .snapshot()
        .map(|config| config.locale)
        .unwrap_or_else(|_| "en".to_string());
    let open_main_window = MenuItem::with_id(
        app,
        "open-main-window",
        native_text(&locale, NativeText::OpenMainWindow),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        native_text(&locale, NativeText::Quit),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open_main_window, &quit])?;
    let click_state = Arc::new(Mutex::new(MacosTrayClickState::default()));
    let double_click_interval = Duration::from_secs_f64(NSEvent::doubleClickInterval());

    let tray = TrayIconBuilder::with_id(MACOS_TRAY_ID)
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("application icon is required for the tray"),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "open-main-window" => show_main_window(app_handle),
            "quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if !matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                return;
            }

            let now = Instant::now();
            let Ok(mut state) = click_state.lock() else {
                eprintln!("Failed to read tray click state");
                return;
            };
            state.sequence += 1;
            let sequence = state.sequence;

            if state
                .last_click
                .is_some_and(|last_click| now.duration_since(last_click) <= double_click_interval)
            {
                state.last_click = None;
                drop(state);
                show_main_window(tray.app_handle());
                return;
            }

            state.last_click = Some(now);
            drop(state);

            let app_handle = tray.app_handle().clone();
            let click_state = Arc::clone(&click_state);
            let tray_id = tray.id().clone();
            thread::spawn(move || {
                thread::sleep(double_click_interval);
                let should_show_menu = match click_state.lock() {
                    Ok(mut state) if state.sequence == sequence => {
                        state.last_click = None;
                        true
                    }
                    Ok(_) => false,
                    Err(_) => {
                        eprintln!("Failed to read tray click state");
                        false
                    }
                };
                if !should_show_menu {
                    return;
                }

                if let Some(tray) = app_handle.tray_by_id(&tray_id) {
                    show_macos_tray_menu(&tray);
                }
            });
        })
        .build(app)?;

    tray.with_inner_tray_icon(|tray_icon| {
        if let Some(status_item) = tray_icon.ns_status_item() {
            status_item.setBehavior(NSStatusItemBehavior::RemovalAllowed);
            status_item.setAutosaveName(Some(&NSString::from_str(MACOS_TRAY_ID)));
        }
    })?;

    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_ID: &str = "windows-tray";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_OPEN_MENU_ID: &str = "windows-tray-open-main-window";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_MINI_MENU_ID: &str = "windows-tray-mini-window";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_STATUS_MENU_ID: &str = "windows-tray-core-status";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_QUOTA_MENU_ID: &str = "windows-tray-quota";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_TOGGLE_CORE_MENU_ID: &str = "windows-tray-toggle-core";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_RESTART_CORE_MENU_ID: &str = "windows-tray-restart-core";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_TRAY_QUIT_MENU_ID: &str = "windows-tray-quit";

#[cfg(target_os = "linux")]
pub(crate) fn linux_tray_available(app_handle: &tauri::AppHandle) -> bool {
    use dbus::{arg::Variant, blocking::Connection};

    if app_handle.tray_by_id(WINDOWS_TRAY_ID).is_none() {
        return false;
    }

    let Ok(connection) = Connection::new_session() else {
        return false;
    };
    let proxy = connection.with_proxy(
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        Duration::from_millis(500),
    );
    let host_registered: Result<(Variant<bool>,), _> = proxy.method_call(
        "org.freedesktop.DBus.Properties",
        "Get",
        (
            "org.kde.StatusNotifierWatcher",
            "IsStatusNotifierHostRegistered",
        ),
    );
    matches!(host_registered, Ok((Variant(true),)))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[derive(Clone, Copy)]
pub(crate) enum WindowsTrayCoreAction {
    Toggle,
    Restart,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) struct WindowsTrayPresentation {
    pub(crate) status_text: String,
    pub(crate) toggle_text: String,
    pub(crate) toggle_enabled: bool,
    pub(crate) restart_enabled: bool,
    pub(crate) tooltip: String,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn windows_tray_presentation(
    status: &CoreStatus,
    busy: bool,
    locale: &str,
) -> WindowsTrayPresentation {
    let status_text = if busy {
        native_text(locale, NativeText::CoreStatusWorking)
    } else if !status.installed {
        native_text(locale, NativeText::CoreStatusNotInstalled)
    } else if status.running {
        native_text(locale, NativeText::CoreStatusRunning)
    } else {
        native_text(locale, NativeText::CoreStatusStopped)
    };
    let toggle_text = if busy {
        native_text(locale, NativeText::Working)
    } else if status.running {
        native_text(locale, NativeText::StopCore)
    } else {
        native_text(locale, NativeText::StartCore)
    };
    let tooltip = if busy {
        native_text(locale, NativeText::TooltipCoreWorking)
    } else if !status.installed {
        native_text(locale, NativeText::TooltipCoreNotInstalled)
    } else if status.running {
        native_text(locale, NativeText::TooltipCoreRunning)
    } else {
        native_text(locale, NativeText::TooltipCoreStopped)
    };

    WindowsTrayPresentation {
        status_text: status_text.to_string(),
        toggle_text: toggle_text.to_string(),
        toggle_enabled: status.installed && !busy,
        restart_enabled: status.installed && status.running && !busy,
        tooltip: tooltip.to_string(),
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) struct WindowsTrayState {
    open_main_window: MenuItem<tauri::Wry>,
    status_item: MenuItem<tauri::Wry>,
    quota_item: MenuItem<tauri::Wry>,
    toggle_core_item: MenuItem<tauri::Wry>,
    restart_core_item: MenuItem<tauri::Wry>,
    quit_item: MenuItem<tauri::Wry>,
    locale: Mutex<String>,
    busy: AtomicBool,
    /// Proxy state line, kept so a quota update can rebuild the tooltip without a CoreStatus.
    base_tooltip: Mutex<String>,
    /// One-line quota summary from the window's background watcher, e.g. "Claude 1 low · Codex ok".
    quota_tooltip: Mutex<String>,
    /// What the proxy and the quotas say the icon should show, and what it shows now.
    core_badge: Mutex<TrayBadge>,
    quota_badge: Mutex<TrayBadge>,
    /// Share of accounts that can still take requests, in whole percent; None until the first quota check.
    quota_gauge: Mutex<Option<u8>>,
    shown_icon: Mutex<TrayIconMark>,
    /// The plain icon as RGBA, width and height, to draw dots on.
    base_icon: Option<(Vec<u8>, u32, u32)>,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
impl WindowsTrayState {
    fn locale(&self) -> String {
        self.locale
            .lock()
            .map(|locale| locale.clone())
            .unwrap_or_else(|_| "en".to_string())
    }

    fn set_locale(&self, locale: &str) {
        let normalized = normalize_app_locale(locale);
        if let Ok(mut current) = self.locale.lock() {
            *current = normalized.to_string();
        }
        let labels = [
            (
                &self.open_main_window,
                native_text(normalized, NativeText::OpenMainWindow),
            ),
            (
                &self.restart_core_item,
                native_text(normalized, NativeText::RestartCore),
            ),
            (&self.quit_item, native_text(normalized, NativeText::Quit)),
        ];
        for (item, label) in labels {
            if let Err(error) = item.set_text(label) {
                eprintln!("Failed to update desktop tray language: {error}");
            }
        }
    }

    fn begin_action(&self) -> bool {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }

        let locale = self.locale();
        if let Err(error) = self
            .status_item
            .set_text(native_text(&locale, NativeText::CoreStatusWorking)) {
            eprintln!("Failed to update desktop tray core status: {error}");
        }
        if let Err(error) =
            self.toggle_core_item
                .set_text(native_text(&locale, NativeText::Working))
        {
            eprintln!("Failed to update desktop tray action text: {error}");
        }
        if let Err(error) = self.toggle_core_item.set_enabled(false) {
            eprintln!("Failed to update desktop tray action state: {error}");
        }
        if let Err(error) = self.restart_core_item.set_enabled(false) {
            eprintln!("Failed to update desktop tray restart state: {error}");
        }
        true
    }

    fn finish_action(&self) {
        self.busy.store(false, Ordering::Release);
    }

    fn update(&self, status: &CoreStatus) -> String {
        let presentation =
            windows_tray_presentation(status, self.busy.load(Ordering::Acquire), &self.locale());
        if let Err(error) = self.status_item.set_text(presentation.status_text.clone()) {
            eprintln!("Failed to update desktop tray core status: {error}");
        }
        if let Err(error) = self
            .toggle_core_item
            .set_text(presentation.toggle_text.clone())
        {
            eprintln!("Failed to update desktop tray action text: {error}");
        }
        if let Err(error) = self
            .toggle_core_item
            .set_enabled(presentation.toggle_enabled)
        {
            eprintln!("Failed to update desktop tray action state: {error}");
        }
        if let Err(error) = self
            .restart_core_item
            .set_enabled(presentation.restart_enabled)
        {
            eprintln!("Failed to update desktop tray restart state: {error}");
        }
        if let Ok(mut base) = self.base_tooltip.lock() {
            *base = presentation.tooltip;
        }
        if !self.busy.load(Ordering::Acquire) {
            self.set_core_badge(if status.installed && status.running { TrayBadge::None } else { TrayBadge::Stopped });
        }
        self.tooltip()
    }

    fn set_core_badge(&self, badge: TrayBadge) {
        if let Ok(mut current) = self.core_badge.lock() {
            *current = badge;
        }
    }

    fn set_quota_badge(&self, badge: TrayBadge) {
        if let Ok(mut current) = self.quota_badge.lock() {
            *current = badge;
        }
    }

    fn set_quota_gauge(&self, gauge: Option<f64>) {
        if let Ok(mut current) = self.quota_gauge.lock() {
            *current = gauge.filter(|value| value.is_finite()).map(|value| (value.clamp(0.0, 1.0) * 100.0).round() as u8);
        }
    }

    /// Redraws the icon when what it should show changed; does nothing otherwise.
    fn refresh_icon(&self, app_handle: &tauri::AppHandle) {
        let core = self.core_badge.lock().map(|badge| *badge).unwrap_or(TrayBadge::None);
        let quota = self.quota_badge.lock().map(|badge| *badge).unwrap_or(TrayBadge::None);
        let gauge = self.quota_gauge.lock().map(|gauge| *gauge).unwrap_or(None);
        let wanted = tray_icon_mark(core, quota, gauge);
        let Ok(mut shown) = self.shown_icon.lock() else { return };
        if *shown == wanted {
            return;
        }
        let Some((rgba, width, height)) = self.base_icon.as_ref() else { return };
        let pixels = match wanted {
            TrayIconMark::Plain => rgba.clone(),
            TrayIconMark::Dot(badge) => badge.color().map_or_else(|| rgba.clone(), |color| badged_rgba(rgba, *width, *height, color)),
            TrayIconMark::Gauge(badge, percent) => gauged_rgba(rgba, *width, *height, f64::from(percent) / 100.0, badge.gauge_color()),
        };
        if let Some(tray) = app_handle.tray_by_id(WINDOWS_TRAY_ID) {
            match tray.set_icon(Some(tauri::image::Image::new_owned(pixels, *width, *height))) {
                Ok(()) => *shown = wanted,
                Err(error) => eprintln!("Failed to update desktop tray icon: {error}"),
            }
        }
    }

    fn tooltip(&self) -> String {
        let base = self.base_tooltip.lock().map(|text| text.clone()).unwrap_or_default();
        let quota = self.quota_tooltip.lock().map(|text| text.clone()).unwrap_or_default();
        windows_tray_tooltip(&base, &quota)
    }

    fn show_error(&self, error: &str) {
        let mut summary = error.chars().take(48).collect::<String>();
        if error.chars().count() > 48 {
            summary.push('…');
        }
        self.set_core_badge(TrayBadge::Error);
        let text = native_operation_failed(&self.locale(), &summary);
        if let Err(update_error) = self.status_item.set_text(text) {
            eprintln!("Failed to update desktop tray error state: {update_error}");
        }
    }
}

/// The dot on the tray icon. Worst first: a failed action, a stopped proxy, then quota.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum TrayBadge {
    None,
    Low,
    Out,
    Stopped,
    Error,
}

impl TrayBadge {
    pub(crate) fn from_quota_level(level: Option<&str>) -> Self {
        match level {
            Some("out") => TrayBadge::Out,
            Some("low") => TrayBadge::Low,
            _ => TrayBadge::None,
        }
    }

    pub(crate) fn color(self) -> Option<[u8; 3]> {
        match self {
            TrayBadge::None => None,
            TrayBadge::Low => Some([245, 158, 11]),
            TrayBadge::Out => Some([234, 88, 12]),
            TrayBadge::Stopped => Some([120, 120, 120]),
            TrayBadge::Error => Some([220, 38, 38]),
        }
    }

    /// The gauge's fill: green when every provider is fine, otherwise the quota dot's colour.
    pub(crate) fn gauge_color(self) -> [u8; 3] {
        self.color().unwrap_or([22, 163, 74])
    }
}

/// What the tray icon shows on top of the plain icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayIconMark {
    Plain,
    Dot(TrayBadge),
    /// Quota state and the share of accounts still usable, in whole percent.
    Gauge(TrayBadge, u8),
}

/// A stopped or failed proxy shows its dot, since quota means nothing then; otherwise the quota gauge once
/// a check has run, or the quota dot before that.
pub(crate) fn tray_icon_mark(core: TrayBadge, quota: TrayBadge, gauge: Option<u8>) -> TrayIconMark {
    if core != TrayBadge::None {
        return TrayIconMark::Dot(core.max(quota));
    }
    match (gauge, quota) {
        (Some(percent), _) => TrayIconMark::Gauge(quota, percent.min(100)),
        (None, TrayBadge::None) => TrayIconMark::Plain,
        (None, badge) => TrayIconMark::Dot(badge),
    }
}

/// The icon with a bar along its bottom edge, filled from the left to `fraction`, inside a white ring so it reads on
/// light and dark taskbars.
pub(crate) fn gauged_rgba(rgba: &[u8], width: u32, height: u32, fraction: f64, color: [u8; 3]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = f64::from(width.min(height));
    let ring = (size * 0.06).max(1.0).round() as u32;
    let bar = (size * 0.2).max(3.0).round() as u32;
    let (left, right) = (ring, width.saturating_sub(ring));
    let bottom = height.saturating_sub(ring);
    let top = bottom.saturating_sub(bar);
    let filled = f64::from(left) + f64::from(right.saturating_sub(left)) * fraction.clamp(0.0, 1.0);
    for y in top.saturating_sub(ring)..height.min(bottom + ring) {
        for x in left.saturating_sub(ring)..width.min(right + ring) {
            let index = ((y * width + x) * 4) as usize;
            let Some(pixel) = out.get_mut(index..index + 4) else { continue };
            let inside = x >= left && x < right && y >= top && y < bottom;
            let shade = if !inside {
                [255, 255, 255]
            } else {
                // How much of this pixel the fill covers, so a part-filled pixel blends instead of jumping.
                let cover = (filled - f64::from(x)).clamp(0.0, 1.0);
                let empty = [70.0, 70.0, 70.0];
                [0, 1, 2].map(|channel| (empty[channel] + (f64::from(color[channel]) - empty[channel]) * cover).round() as u8)
            };
            pixel[..3].copy_from_slice(&shade);
            pixel[3] = 255;
        }
    }
    out
}

/// The icon with a filled dot and a white ring in its bottom-right corner, big enough to read at tray size.
pub(crate) fn badged_rgba(rgba: &[u8], width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = width.min(height) as f64;
    let radius = size * 0.26;
    let ring = (size * 0.06).max(1.0);
    let (cx, cy) = (width as f64 - radius - ring, height as f64 - radius - ring);
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            // How much of this pixel the dot and the ring around it cover, softened over one pixel.
            let dot = (radius - distance + 0.5).clamp(0.0, 1.0);
            let outer = (radius + ring - distance + 0.5).clamp(0.0, 1.0);
            if outer <= 0.0 {
                continue;
            }
            let index = ((y * width + x) * 4) as usize;
            let Some(pixel) = out.get_mut(index..index + 4) else { continue };
            for channel in 0..3 {
                let base = f64::from(pixel[channel]);
                let ringed = base + (255.0 - base) * outer;
                pixel[channel] = (ringed + (f64::from(color[channel]) - ringed) * dot).round() as u8;
            }
            pixel[3] = pixel[3].max((outer * 255.0).round() as u8);
        }
    }
    out
}

/// Windows truncates tray tooltips at 127 characters, so the quota line is cut to fit.
pub(crate) fn windows_tray_tooltip(base: &str, quota: &str) -> String {
    const LIMIT: usize = 127;
    let quota = quota.trim();
    if quota.is_empty() {
        return base.chars().take(LIMIT).collect();
    }
    let combined = format!("{base}
{quota}");
    if combined.chars().count() <= LIMIT {
        return combined;
    }
    let mut cut: String = combined.chars().take(LIMIT - 1).collect();
    cut.push('…');
    cut
}

/// Called by the window's quota watcher with a localized summary for the tray menu and tooltip.
#[tauri::command]
pub(crate) fn set_tray_quota_summary(app: tauri::AppHandle, menu_text: String, tooltip_text: String, level: Option<String>, gauge: Option<f64>, providers: Option<serde_json::Value>) {
    crate::mini_window::remember_summary(&app, &menu_text, &tooltip_text, level.as_deref(), providers);
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let Some(tray_state) = app.try_state::<WindowsTrayState>() else {
            return;
        };
        if let Ok(mut quota) = tray_state.quota_tooltip.lock() {
            *quota = tooltip_text;
        }
        tray_state.set_quota_badge(TrayBadge::from_quota_level(level.as_deref()));
        tray_state.set_quota_gauge(gauge);
        tray_state.refresh_icon(&app);
        if let Err(error) = tray_state.quota_item.set_text(menu_text) {
            eprintln!("Failed to update desktop tray quota line: {error}");
        }
        if let Some(tray) = app.tray_by_id(WINDOWS_TRAY_ID) {
            if let Err(error) = tray.set_tooltip(Some(&tray_state.tooltip())) {
                eprintln!("Failed to update desktop tray tooltip: {error}");
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (app, menu_text, tooltip_text, level);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn show_windows_main_window(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.show() {
        eprintln!("Failed to show the main window: {error}");
        return;
    }
    if window.is_minimized().unwrap_or(false) {
        if let Err(error) = window.unminimize() {
            eprintln!("Failed to restore the main window: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        eprintln!("Failed to focus the main window: {error}");
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn update_windows_tray_status(app_handle: &tauri::AppHandle, status: &CoreStatus) {
    let tooltip = app_handle
        .try_state::<WindowsTrayState>()
        .map(|tray_state| {
            let tooltip = tray_state.update(status);
            tray_state.refresh_icon(app_handle);
            tooltip
        })
        .unwrap_or_else(|| windows_tray_presentation(status, false, "en").tooltip);

    if let Some(tray) = app_handle.tray_by_id(WINDOWS_TRAY_ID) {
        if let Err(error) = tray.set_tooltip(Some(&tooltip)) {
            eprintln!("Failed to update desktop tray tooltip: {error}");
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn update_windows_tray_locale(
    app_handle: &tauri::AppHandle,
    locale: &str,
    status: &CoreStatus,
) {
    if let Some(tray_state) = app_handle.try_state::<WindowsTrayState>() {
        tray_state.set_locale(locale);
    }
    update_windows_tray_status(app_handle, status);
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn show_windows_tray_action_error(app_handle: &tauri::AppHandle, error: &str) {
    eprintln!("Desktop tray core operation failed: {error}");
    let locale = app_handle
        .try_state::<WindowsTrayState>()
        .map(|state| state.locale())
        .unwrap_or_else(|| "en".to_string());
    if let Some(tray_state) = app_handle.try_state::<WindowsTrayState>() {
        tray_state.show_error(error);
        tray_state.refresh_icon(app_handle);
    }
    // Keep the quota line under the status, as the normal tooltip does.
    let quota = app_handle
        .try_state::<WindowsTrayState>()
        .and_then(|state| state.quota_tooltip.lock().ok().map(|text| text.clone()))
        .unwrap_or_default();
    if let Some(tray) = app_handle.tray_by_id(WINDOWS_TRAY_ID) {
        if let Err(update_error) = tray.set_tooltip(Some(windows_tray_tooltip(
            &native_text(&locale, NativeText::TooltipCoreOperationFailed),
            &quota,
        ))) {
            eprintln!("Failed to update desktop tray error tooltip: {update_error}");
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn run_windows_tray_core_action(
    app_handle: &tauri::AppHandle,
    action: WindowsTrayCoreAction,
) {
    let Some(tray_state) = app_handle.try_state::<WindowsTrayState>() else {
        return;
    };
    if !tray_state.begin_action() {
        return;
    }
    if let Some(tray) = app_handle.tray_by_id(WINDOWS_TRAY_ID) {
        let quota = tray_state.quota_tooltip.lock().map(|text| text.clone()).unwrap_or_default();
        if let Err(error) = tray.set_tooltip(Some(windows_tray_tooltip(
            &native_text(&tray_state.locale(), NativeText::TooltipCoreWorking),
            &quota,
        ))) {
            eprintln!("Failed to update desktop tray busy tooltip: {error}");
        }
    }

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let process_state = app_handle.state::<CoreProcessState>();
        let gui_config_state = app_handle.state::<GuiConfigState>();
        let result = (|| -> Result<CoreStatus, String> {
            let _guard = lock_core_operation(process_state.inner())?;
            match action {
                WindowsTrayCoreAction::Toggle => {
                    let config = gui_config_state.snapshot()?;
                    let status =
                        current_core_status(Some(process_state.inner()), Some(config.port))?;
                    if status.running {
                        stop_core_process_with_state(
                            process_state.inner(),
                            gui_config_state.inner(),
                        )
                    } else {
                        start_core_process_with_state(
                            process_state.inner(),
                            gui_config_state.inner(),
                        )
                    }
                }
                WindowsTrayCoreAction::Restart => {
                    restart_core_process_with_state(process_state.inner(), gui_config_state.inner())
                }
            }
        })();

        if let Some(tray_state) = app_handle.try_state::<WindowsTrayState>() {
            tray_state.finish_action();
        }

        match result {
            Ok(status) => emit_core_status(&app_handle, &status),
            Err(error) => {
                if let Ok(config) = gui_config_state.snapshot() {
                    if let Ok(status) =
                        current_core_status(Some(process_state.inner()), Some(config.port))
                    {
                        emit_core_status(&app_handle, &status);
                    }
                }
                show_windows_tray_action_error(&app_handle, &error);
            }
        }
    });
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn setup_windows_tray(app: &mut tauri::App<tauri::Wry>) -> tauri::Result<()> {
    let locale = app
        .state::<GuiConfigState>()
        .snapshot()
        .map(|config| config.locale)
        .unwrap_or_else(|_| "en".to_string());
    let open_main_window = MenuItem::with_id(
        app,
        WINDOWS_TRAY_OPEN_MENU_ID,
        native_text(&locale, NativeText::OpenMainWindow),
        true,
        None::<&str>,
    )?;
    let mini_window = MenuItem::with_id(
        app,
        WINDOWS_TRAY_MINI_MENU_ID,
        native_text(&locale, NativeText::MiniWindow),
        true,
        None::<&str>,
    )?;
    let status_item = MenuItem::with_id(
        app,
        WINDOWS_TRAY_STATUS_MENU_ID,
        native_text(&locale, NativeText::CoreStatusChecking),
        false,
        None::<&str>,
    )?;
    let quota_item = MenuItem::with_id(
        app,
        WINDOWS_TRAY_QUOTA_MENU_ID,
        "…",
        false,
        None::<&str>,
    )?;
    let toggle_core_item = MenuItem::with_id(
        app,
        WINDOWS_TRAY_TOGGLE_CORE_MENU_ID,
        native_text(&locale, NativeText::StartCore),
        false,
        None::<&str>,
    )?;
    let restart_core_item = MenuItem::with_id(
        app,
        WINDOWS_TRAY_RESTART_CORE_MENU_ID,
        native_text(&locale, NativeText::RestartCore),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        WINDOWS_TRAY_QUIT_MENU_ID,
        native_text(&locale, NativeText::Quit),
        true,
        None::<&str>,
    )?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_main_window,
            &mini_window,
            &separator_one,
            &status_item,
            &quota_item,
            &toggle_core_item,
            &restart_core_item,
            &separator_two,
            &quit,
        ],
    )?;

    // Linux AppIndicator implementations always open the menu when the icon is
    // activated and do not emit tray click events. Keeping "Open Main Window"
    // as the first item provides the reliable restore path on Linux; Windows
    // additionally supports the double-click shortcut below.
    TrayIconBuilder::with_id(WINDOWS_TRAY_ID)
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("application icon is required for the tray"),
        )
        .tooltip("Tim’s AI Hub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            WINDOWS_TRAY_OPEN_MENU_ID => show_windows_main_window(app_handle),
            WINDOWS_TRAY_MINI_MENU_ID => crate::mini_window::open_mini_window_later(app_handle),
            WINDOWS_TRAY_TOGGLE_CORE_MENU_ID => {
                run_windows_tray_core_action(app_handle, WindowsTrayCoreAction::Toggle)
            }
            WINDOWS_TRAY_RESTART_CORE_MENU_ID => {
                run_windows_tray_core_action(app_handle, WindowsTrayCoreAction::Restart)
            }
            WINDOWS_TRAY_QUIT_MENU_ID => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            // One left click opens the window, as on most Windows tray apps; the menu stays on right-click.
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                }
            ) {
                show_windows_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    let base_icon = app
        .default_window_icon()
        .map(|icon| (icon.rgba().to_vec(), icon.width(), icon.height()));
    let _ = app.manage(WindowsTrayState {
        open_main_window,
        status_item,
        quota_item,
        toggle_core_item,
        restart_core_item,
        quit_item: quit,
        locale: Mutex::new(locale),
        busy: AtomicBool::new(false),
        base_tooltip: Mutex::new(String::new()),
        quota_tooltip: Mutex::new(String::new()),
        core_badge: Mutex::new(TrayBadge::None),
        quota_badge: Mutex::new(TrayBadge::None),
        quota_gauge: Mutex::new(None),
        shown_icon: Mutex::new(TrayIconMark::Plain),
        base_icon,
    });

    Ok(())
}
