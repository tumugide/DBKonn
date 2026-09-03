mod commands;
mod connections;
mod state;
mod updater;

use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

/// Theme ids/labels, kept in sync with `app/src/lib/store.ts`'s `THEMES` map.
#[cfg(target_os = "macos")]
const THEMES: &[(&str, &str)] = &[
    ("bios", "BIOS"),
    ("monokai", "Monokai"),
    ("dark", "Dark"),
    ("light", "Light"),
    ("catppuccin", "Catppuccin"),
    ("ayu-dark", "Ayu Dark"),
    ("ayu-light", "Ayu Light"),
];

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadataBuilder, CheckMenuItem, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
    };

    let check_for_updates = MenuItemBuilder::with_id("check_for_updates", "Check for Updates…")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "DBKonn")
        .about(Some(
            AboutMetadataBuilder::new()
                .name(Some("DBKonn"))
                .version(Some(app.package_info().version.to_string()))
                .build(),
        ))
        .separator()
        .item(&check_for_updates)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;

    let new_query_item = MenuItemBuilder::with_id("query:new", "New Query").build(app)?;
    let query_menu = SubmenuBuilder::new(app, "Query")
        .item(&new_query_item)
        .separator()
        .build()?;
    *app.state::<state::AppState>().query_menu.lock().unwrap_or_else(|e| e.into_inner()) = Some(query_menu.clone());

    let theme_menu = SubmenuBuilder::new(app, "Theme").build()?;
    let mut theme_items = std::collections::HashMap::new();
    for (id, label) in THEMES {
        let item = CheckMenuItem::with_id(
            app,
            format!("theme:{id}"),
            *label,
            true,
            *id == "bios",
            None::<&str>,
        )?;
        theme_menu.append(&item)?;
        theme_items.insert(id.to_string(), item);
    }
    *app.state::<state::AppState>().theme_menu_items.lock().unwrap_or_else(|e| e.into_inner()) = theme_items;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &query_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &theme_menu,
        ])
        .build()
}

#[cfg(target_os = "macos")]
fn set_theme_checked(app: &tauri::AppHandle, theme: &str) {
    let state = app.state::<state::AppState>();
    let items = state.theme_menu_items.lock().unwrap_or_else(|e| e.into_inner());
    for (id, item) in items.iter() {
        let _ = item.set_checked(id == theme);
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::connect_db,
            commands::disconnect_db,
            commands::test_connection,
            commands::list_databases,
            commands::create_database,
            commands::list_schemas,
            commands::list_tables,
            commands::describe_table,
            commands::execute_query,
            commands::fetch_table_rows,
            commands::count_rows,
            commands::validate_sql,
            commands::parse_connection_url,
            commands::save_connection,
            commands::load_connections,
            commands::delete_connection,
            commands::sync_theme_menu,
            commands::sync_query_menu,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app)?;
                app.set_menu(menu)?;

                app.on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "check_for_updates" {
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            updater::check_for_updates(app_handle).await;
                        });
                    } else if let Some(theme) = id.strip_prefix("theme:") {
                        set_theme_checked(app, theme);
                        let _ = app.emit("menu:set-theme", theme);
                    } else if id == "query:new" {
                        let _ = app.emit("menu:new-query", ());
                    } else if let Some(tab_id) = id.strip_prefix("query-tab:") {
                        let _ = app.emit("menu:switch-query-tab", tab_id);
                    }
                });
            }

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
