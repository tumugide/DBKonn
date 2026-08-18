use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;

const REPO_CONTENTS_API: &str =
    "https://api.github.com/repos/tumugide/DBKonn/contents/appbuilds";
const APPBUILDS_PAGE: &str = "https://github.com/tumugide/DBKonn/tree/main/appbuilds";

#[derive(Deserialize)]
struct GithubContentEntry {
    name: String,
}

/// Extracts the version from filenames like `DBKonn_0.1.0_aarch64.dmg`.
fn parse_version_from_filename(name: &str) -> Option<Version> {
    let rest = name.strip_prefix("DBKonn_")?;
    let version_str = rest.split('_').next()?;
    Version::parse(version_str).ok()
}

pub async fn check_for_updates(app: AppHandle) {
    let current_version = app.package_info().version.clone();

    let client = match reqwest::Client::builder().user_agent("DBKonn-App").build() {
        Ok(client) => client,
        Err(err) => {
            show_error(&app, format!("Could not check for updates: {err}"));
            return;
        }
    };

    let response = match client.get(REPO_CONTENTS_API).send().await {
        Ok(response) => response,
        Err(err) => {
            show_error(&app, format!("Could not check for updates: {err}"));
            return;
        }
    };

    if !response.status().is_success() {
        show_error(
            &app,
            format!("Could not check for updates (HTTP {}).", response.status()),
        );
        return;
    }

    let entries: Vec<GithubContentEntry> = match response.json().await {
        Ok(entries) => entries,
        Err(err) => {
            show_error(&app, format!("Could not read update information: {err}"));
            return;
        }
    };

    let latest_version = entries
        .iter()
        .filter_map(|entry| parse_version_from_filename(&entry.name))
        .max();

    match latest_version {
        Some(latest) if latest > current_version => {
            let app_for_callback = app.clone();
            app.dialog()
                .message(format!(
                    "A new version of DBKonn is available.\n\nCurrent version: {current_version}\nLatest version: {latest}"
                ))
                .title("Update Available")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Download".to_string(),
                    "Later".to_string(),
                ))
                .show(move |download| {
                    if download {
                        let _ = app_for_callback.shell().open(APPBUILDS_PAGE, None);
                    }
                });
        }
        Some(_) => {
            show_info(
                &app,
                "You're up to date",
                format!("DBKonn {current_version} is the latest version."),
            );
        }
        None => {
            show_error(
                &app,
                "Could not determine the latest available version.".to_string(),
            );
        }
    }
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
