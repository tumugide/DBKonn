use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Progress payload forwarded to the webview (`update:progress` event) so the
/// frontend can render a progress bar in future releases. The Rust side relies
/// on the native dialog; nothing breaks if no listener is attached yet.
#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Checks for an update via `tauri-plugin-updater`, and if one is available
/// offers to download, verify and install it in place (the app restarts into
/// the new version afterwards).
///
/// The updater is only configured in builds that merge `tauri.updater.conf.json`
/// (the CI release build). Dev/local builds have no endpoints configured, in
/// which case this reports that the feature isn't enabled rather than failing.
pub async fn check_for_updates(app: AppHandle) {
    let current_version = app.package_info().version.clone();

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(tauri_plugin_updater::Error::EmptyEndpoints) => {
            show_info(
                &app,
                "Auto-update not configured",
                "This build of DBKonn was built without the in-app updater.\n\nDownload the latest version from the GitHub releases page instead."
                    .to_string(),
            );
            return;
        }
        Err(err) => {
            show_error(&app, format!("Could not set up the updater: {err}"));
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            show_info(
                &app,
                "You're up to date",
                format!("DBKonn {current_version} is the latest version."),
            );
            return;
        }
        Err(err) => {
            show_error(&app, format!("Could not check for updates: {err}"));
            return;
        }
    };

    let latest = update.version.clone();
    let mut message = format!(
        "A new version of DBKonn is available.\n\nCurrent version: {current_version}\nLatest version: {latest}"
    );
    if let Some(notes) = update.body.as_ref().filter(|b| !b.trim().is_empty()) {
        message.push_str("\n\nRelease notes:\n");
        message.push_str(notes);
    }
    message.push_str("\n\nDownload and install now?");

    let app_for_dialog = app.clone();
    app.dialog()
        .message(message)
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download & Install".to_string(),
            "Later".to_string(),
        ))
        .show(move |install| {
            if !install {
                return;
            }
            let app_for_task = app_for_dialog.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = install_update(app_for_task.clone(), update).await {
                    show_error(&app_for_task, format!("Update failed: {err}"));
                    return;
                }
                // macOS/Linux: the new build is on disk; relaunch into it.
                app_for_task.restart();
            });
        });
}

async fn install_update(
    app: AppHandle,
    update: Update,
) -> Result<(), tauri_plugin_updater::Error> {
    let _ = app.emit("update:status", "downloading");
    let result = update
        .download_and_install(
            |received, total| {
                let _ = app.emit(
                    "update:progress",
                    UpdateProgress {
                        downloaded: received as u64,
                        total,
                    },
                );
            },
            || {
                let _ = app.emit("update:status", "installing");
            },
        )
        .await;
    if result.is_ok() {
        let _ = app.emit("update:status", "restarting");
    }
    result
}

fn show_info(app: &AppHandle, title: &str, message: String) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn show_error(app: &AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title("Check for Updates")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}