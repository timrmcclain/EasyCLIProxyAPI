//! App Routing: installs the bundled proxy plugin (see `app-routing/`) that picks which account pays for each app's
//! requests. Its rules go through the proxy's management API from the frontend; this side only puts the library
//! where the proxy loads plugins from, the same way Secret Guard is installed.

use std::fs;

use serde::Serialize;

use crate::secret_guard::{install_library, installed_plugin_file};

const PLUGIN_ID: &str = "app-routing";

#[cfg(app_routing_bundled)]
static PLUGIN_LIBRARY: &[u8] = include_bytes!(env!("APP_ROUTING_DLL"));
#[cfg(not(app_routing_bundled))]
static PLUGIN_LIBRARY: &[u8] = &[];
#[cfg(app_routing_bundled)]
const BUNDLED_VERSION: &str = env!("APP_ROUTING_VERSION");
#[cfg(not(app_routing_bundled))]
const BUNDLED_VERSION: &str = "";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRoutingInfo {
    bundled: bool,
    bundled_version: String,
    installed: bool,
    /// The plugin file in the proxy's folder is this hub's bundled build, so a restart is all an update needs.
    installed_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRoutingInstall {
    /// An older copy was loaded by the running proxy; the new one takes over after the proxy restarts.
    replaced_loaded_copy: bool,
}

#[tauri::command]
pub(crate) fn app_routing_info() -> Result<AppRoutingInfo, String> {
    let file = installed_plugin_file(PLUGIN_ID)?;
    Ok(AppRoutingInfo {
        bundled: !PLUGIN_LIBRARY.is_empty(),
        bundled_version: BUNDLED_VERSION.to_string(),
        installed: file.is_file(),
        installed_current: !PLUGIN_LIBRARY.is_empty() && fs::read(&file).is_ok_and(|bytes| bytes == PLUGIN_LIBRARY),
    })
}

/// Copies the bundled plugin into the proxy's plugins folder. The proxy loads it the next time its plugin settings
/// change, which the frontend does right after this.
#[tauri::command]
pub(crate) fn app_routing_install() -> Result<AppRoutingInstall, String> {
    if PLUGIN_LIBRARY.is_empty() {
        return Err("This build of the hub doesn't include App Routing.".to_string());
    }
    let replaced_loaded_copy = install_library(&installed_plugin_file(PLUGIN_ID)?, PLUGIN_LIBRARY, PLUGIN_ID, "App Routing")?;
    Ok(AppRoutingInstall { replaced_loaded_copy })
}
