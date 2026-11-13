mod commands;
mod config;
mod secrets;
mod sources;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config_paths,
            commands::load_app_state,
            commands::save_app_state,
            commands::save_board_layout,
            commands::upsert_source,
            commands::store_secrets,
            commands::fetch_source_payload,
            commands::add_panel_to_board,
            commands::create_board,
            commands::set_active_board,
            commands::set_edit_mode,
            commands::validate_source_fields,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Command Center");
}
