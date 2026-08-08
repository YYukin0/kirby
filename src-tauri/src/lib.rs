use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

/// Read a UTF-8 text file. Used on startup to restore the last plan.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
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
        .invoke_handler(tauri::generate_handler![read_text, write_atomic])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
