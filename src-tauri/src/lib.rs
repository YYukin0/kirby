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
    fn can_write_into_real_vault_subdir() {
        // Proves the configured vault path is actually writable.
        let p = "/Users/yyukin0/Documents/obsidian/Study Plans/.tw-selftest.md".to_string();
        write_atomic(p.clone(), "selftest".into()).unwrap();
        assert_eq!(read_text(p.clone()).unwrap(), "selftest");
        let _ = fs::remove_file(&p);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // A native Edit menu is required so ⌘C/⌘V/⌘X work inside the
            // textarea on macOS (frameless windows otherwise have no menu),
            // plus ⌘Q to quit since the window has no title bar.
            use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
            let app_menu = Submenu::with_items(
                app,
                "Typewriter Plan",
                true,
                &[&PredefinedMenuItem::quit(app, None)?],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let menu = Menu::with_items(app, &[&app_menu, &edit_menu])?;
            app.set_menu(menu)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_text, write_atomic])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
