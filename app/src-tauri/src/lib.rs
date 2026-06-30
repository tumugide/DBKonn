mod commands;
mod connections;
mod state;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

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
            commands::list_schemas,
            commands::list_tables,
            commands::describe_table,
            commands::execute_query,
            commands::fetch_table_rows,
            commands::count_rows,
            commands::validate_sql,
            commands::save_connection,
            commands::load_connections,
            commands::delete_connection,
            commands::get_active_connections,
        ])
        .setup(|app| {
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
