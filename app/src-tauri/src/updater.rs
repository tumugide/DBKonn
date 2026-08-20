use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;

const RELEASES_API: &str = "https://api.github.com/repos/tumugide/DBKonn/releases/latest";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Extracts the version from tags like `v0.1.4`.
fn parse_version_from_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
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

    let response = match client.get(RELEASES_API).send().await {
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

    let release: GithubRelease = match response.json().await {
        Ok(release) => release,
        Err(err) => {
            show_error(&app, format!("Could not read update information: {err}"));
            return;
        }
    };

    let latest_version = parse_version_from_tag(&release.tag_name);

    match latest_version {
        Some(latest) if latest > current_version => {
            // Prefer linking straight to the Apple Silicon dmg asset; fall back to
            // the release page itself if the asset naming ever changes.
            let download_url = release
                .assets
                .iter()
                .find(|a| a.name.ends_with("aarch64.dmg"))
                .map(|a| a.browser_download_url.clone())
                .unwrap_or(release.html_url);

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
                        let _ = app_for_callback.shell().open(download_url, None);
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
