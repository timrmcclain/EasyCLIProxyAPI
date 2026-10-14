use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=GITCODE_GUI_REPOSITORY");
    println!("cargo:rerun-if-env-changed=GITCODE_CORE_REPOSITORY");
    bundle_secret_guard();
    tauri_build::build()
}

/// Embeds the Secret Guard proxy plugin when it has been built (release.ps1 builds it first).
/// Builds without it still work; the Secret Guard page then says the plugin isn't included.
fn bundle_secret_guard() {
    println!("cargo:rustc-check-cfg=cfg(secret_guard_bundled)");
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("secret-guard");
    let library = if cfg!(windows) { "secret_guard.dll" } else { "libsecret_guard.so" };
    let built = crate_dir.join("target").join("release").join(library);
    println!("cargo:rerun-if-changed={}", built.display());
    println!("cargo:rerun-if-changed={}", crate_dir.join("Cargo.toml").display());
    if !built.is_file() {
        return;
    }
    let manifest = std::fs::read_to_string(crate_dir.join("Cargo.toml")).unwrap_or_default();
    let version = manifest
        .lines()
        .find_map(|line| line.trim().strip_prefix("version = \"")?.strip_suffix('"').map(str::to_string))
        .unwrap_or_default();
    println!("cargo:rustc-cfg=secret_guard_bundled");
    println!("cargo:rustc-env=SECRET_GUARD_DLL={}", built.display());
    println!("cargo:rustc-env=SECRET_GUARD_VERSION={version}");
}
