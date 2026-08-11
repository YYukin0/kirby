use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

/// Read a UTF-8 text file. Used on startup to restore the last plan.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Cheap change signature for a file: `(mtime_ms, len)`. The frontend polls this
/// every couple of seconds and only does a full `read_text` when it changes, so
/// an idle pet never allocates a whole-file string on each poll.
#[tauri::command]
fn plan_stat(path: String) -> Result<(u128, u64), String> {
    let m = fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok((mtime, m.len()))
}

/// Where the app keeps its own config file (plan-file override lives here).
fn config_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("config.json"))
}

/// The default plan file, derived from the user's home dir — no hardcoded
/// per-user absolute path in the source.
fn default_plan_path(app: &tauri::AppHandle) -> String {
    let home = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join("Documents")
        .join("obsidian")
        .join("Study Plans")
        .join("current.md")
        .to_string_lossy()
        .into_owned()
}

/// Resolve the plan file. Precedence: TYPEWRITER_PLAN env var, then a
/// `plan_file` entry in the app's config.json, then the home-based default.
fn resolve_plan_path(app: &tauri::AppHandle) -> String {
    if let Ok(p) = std::env::var("TYPEWRITER_PLAN") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    if let Some(cfg) = config_file(app) {
        if let Ok(text) = fs::read_to_string(&cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(p) = v.get("plan_file").and_then(|p| p.as_str()) {
                    if !p.trim().is_empty() {
                        return p.to_string();
                    }
                }
            }
        }
    }
    default_plan_path(app)
}

/// Persist a chosen plan file into config.json (used by the tray picker).
fn save_plan_path(app: &tauri::AppHandle, plan_file: &str) -> Result<(), String> {
    let cfg = config_file(app).ok_or_else(|| "no config dir".to_string())?;
    if let Some(dir) = cfg.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({ "plan_file": plan_file }).to_string();
    fs::write(&cfg, body).map_err(|e| e.to_string())
}

/// The frontend asks for the resolved plan path on startup and on each poll,
/// so changing it (env / config / tray picker) switches the shown plan live.
#[tauri::command]
fn plan_path(app: tauri::AppHandle) -> String {
    resolve_plan_path(&app)
}

/// Write `contents` to `path` atomically: write to a temp file in the same
/// directory, fsync it, then rename over the target. This means a reader
/// (e.g. Obsidian) never sees a half-written file.
#[tauri::command]
fn write_atomic(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| "invalid target path".to_string())?;

    fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let tmp = dir.join(format!(".{file_name}.tmp"));

    {
        let mut f = File::create(&tmp).map_err(|e| format!("temp create failed: {e}"))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync failed: {e}"))?;
    }

    fs::rename(&tmp, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn round_trip_creates_dirs_and_reads_back() {
        let dir = env::temp_dir().join("tw-test-round");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("plan.md");
        let p = path.to_str().unwrap().to_string();

        write_atomic(p.clone(), "# Hi\n- [x] done\n".into()).unwrap();
        let got = read_text(p).unwrap();
        assert_eq!(got, "# Hi\n- [x] done\n");
        // no leftover temp file
        let tmp = path.parent().unwrap().join(".plan.md.tmp");
        assert!(!tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrites_same_file() {
        let dir = env::temp_dir().join("tw-test-over");
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("plan.md").to_str().unwrap().to_string();
        write_atomic(p.clone(), "one".into()).unwrap();
        write_atomic(p.clone(), "two".into()).unwrap();
        assert_eq!(read_text(p).unwrap(), "two");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_stat_reports_len_and_tracks_changes() {
        let dir = env::temp_dir().join("tw-test-stat");
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("plan.md").to_str().unwrap().to_string();

        // Missing file → error (frontend treats this as "file removed").
        assert!(plan_stat(p.clone()).is_err());

        write_atomic(p.clone(), "hello".into()).unwrap();
        let (_mtime1, len1) = plan_stat(p.clone()).unwrap();
        assert_eq!(len1, 5);

        // A different-length write changes the signature.
        write_atomic(p.clone(), "hello world".into()).unwrap();
        let (_mtime2, len2) = plan_stat(p.clone()).unwrap();
        assert_eq!(len2, 11);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_missing_subdir_before_writing() {
        // Proves write_atomic creates a nested subdirectory that doesn't exist
        // yet (mirrors pointing the pet at a fresh "Study Plans" folder), using a
        // throwaway temp dir so the test never touches a real user vault.
        let dir = env::temp_dir().join("tw-test-subdir");
        let _ = fs::remove_dir_all(&dir);
        let p = dir
            .join("Study Plans")
            .join("current.md")
            .to_str()
            .unwrap()
            .to_string();
        write_atomic(p.clone(), "selftest".into()).unwrap();
        assert_eq!(read_text(p).unwrap(), "selftest");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_autostart::MacosLauncher;
    use tauri_plugin_window_state::StateFlags;

    tauri::Builder::default()
        // Register autostart before setup so the tray can read/toggle it. On
        // macOS this installs a LaunchAgent that relaunches Kirby at login.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Remember where the pet was dragged. The window is a fixed-size,
        // transparent, borderless pet, so persist only its POSITION — never
        // size/maximized/fullscreen, which would fight the 300x360 layout.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        // Native file picker for the tray "Choose plan file…" item.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;
            use tauri::Manager;
            use tauri_plugin_autostart::ManagerExt;

            // Live in the macOS menu bar only: no Dock icon, no app menu. The
            // always-on-top pet window stays visible regardless.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Menu-bar (tray) icon with a small menu: show/hide + start-at-login
            // toggle + quit. The check item reflects the current autostart state.
            let toggle = MenuItem::with_id(app, "toggle", "Show / hide Kirby", true, None::<&str>)?;
            let choose = MenuItem::with_id(app, "choose_plan", "Choose plan file…", true, None::<&str>)?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let start_at_login = CheckMenuItem::with_id(
                app,
                "start_at_login",
                "Start at login",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let quit = PredefinedMenuItem::quit(app, Some("Quit Kirby"))?;
            let menu = Menu::with_items(
                app,
                &[
                    &toggle,
                    &choose,
                    &start_at_login,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            TrayIconBuilder::with_id("kirby-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Kirby — study plan")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                    "choose_plan" => {
                        use tauri_plugin_dialog::DialogExt;
                        let app2 = app.clone();
                        app.dialog()
                            .file()
                            .add_filter("Markdown", &["md"])
                            .pick_file(move |resp| {
                                if let Some(fp) = resp {
                                    if let Ok(pb) = fp.into_path() {
                                        // The frontend re-resolves the path on its
                                        // next poll and switches to the new plan.
                                        let _ = save_plan_path(&app2, &pb.to_string_lossy());
                                    }
                                }
                            });
                    }
                    "start_at_login" => {
                        let mgr = app.autolaunch();
                        let now_on = if mgr.is_enabled().unwrap_or(false) {
                            let _ = mgr.disable();
                            false
                        } else {
                            let _ = mgr.enable();
                            true
                        };
                        // Keep the checkmark in sync with what actually stuck.
                        let _ = start_at_login.set_checked(mgr.is_enabled().unwrap_or(now_on));
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_text, write_atomic, plan_path, plan_stat])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
