use dbkonn_core::query::SavedQuery;
use std::path::PathBuf;
use std::sync::Mutex;

/// Serializes concurrent writers to `saved_queries.json`, mirroring the
/// `WRITE_LOCK` in `connections.rs` so save/delete can't race (last-writer
/// would clobber the other's change).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn saved_queries_path() -> PathBuf {
    crate::connections::config_dir().join("saved_queries.json")
}

pub fn load_saved_queries() -> Result<Vec<SavedQuery>, String> {
    let path = saved_queries_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Reading {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "{} is corrupt ({}). It has not been modified; fix or remove it to recover your saved queries.",
            path.display(),
            e
        )
    })
}

pub fn save_saved_queries(queries: &[SavedQuery]) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let dir = crate::connections::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(queries).map_err(|e| e.to_string())?;

    // Temp-file + atomic rename, like connections.json — a crash mid-write
    // must not leave a truncated, unparseable file that swallows every snippet.
    let final_path = saved_queries_path();
    let tmp_path = dir.join("saved_queries.json.tmp");
    std::fs::write(&tmp_path, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    Ok(())
}
