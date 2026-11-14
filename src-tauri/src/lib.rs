mod ai_sync;
mod auth;
mod cast;
mod commands;
mod config;
mod local_ai;
mod local_server;
mod location;
mod media;
mod safety;
mod secrets;
mod sources;
mod sync;
mod updates;

use tauri::menu::{Menu, MenuItem, Submenu, HELP_SUBMENU_ID};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Err(err) = install_update_menu(app) {
                eprintln!("command-center: update menu was not installed: {err}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "check-updates" {
                let _ = app.emit("check-updates", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config_paths,
            commands::load_app_state,
            commands::save_app_state,
            commands::save_board_layout,
            commands::upsert_source,
            commands::store_secrets,
            commands::fetch_source_payload,
            commands::fetch_media_url,
            commands::add_panel_to_board,
            commands::create_board,
            commands::set_active_board,
            commands::set_edit_mode,
            commands::validate_source_fields,
            commands::resolve_location,
            commands::transcribe_audio_local,
            commands::transcribe_media_local,
            commands::list_audio_inputs,
            commands::listen_safety_feed,
            commands::safety_clip,
            commands::auth_session,
            commands::auth_probe,
            commands::auth_save_settings,
            commands::auth_register,
            commands::auth_login,
            commands::auth_logout,
            commands::sync_board,
            commands::set_display_size,
            commands::display_work_area,
            cast::list_cast_screens,
            cast::scan_airplay,
            cast::cast_start,
            cast::cast_stop,
            cast::cast_status,
            cast::cast_split,
            cast::span_show,
            cast::span_hide,
            cast::cast_preview,
            cast::cast_close_preview,
            commands::local_server_status,
            commands::local_server_install,
            commands::local_server_open_admin,
            commands::local_server_start,
            commands::local_server_stop,
            commands::local_server_set_secrets,
            commands::local_server_export_backup,
            commands::local_server_import_backup,
            commands::local_ai_status,
            commands::local_ai_install,
            commands::local_ai_remove,
            commands::sync_ai_memory,
            commands::save_ai_memory,
            commands::check_updates,
            commands::apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Command Center");
}

fn install_update_menu(app: &tauri::App) -> tauri::Result<()> {
    let check = MenuItem::with_id(
        app,
        "check-updates",
        "Check for updates…",
        true,
        Some("CmdOrCtrl+U"),
    )?;
    let menu = Menu::default(app.handle())?;
    let help = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned());
    if let Some(help) = help {
        help.append(&check)?;
    } else {
        let help = Submenu::with_items(app, "Help", true, &[&check])?;
        menu.append(&help)?;
    }
    app.set_menu(menu)?;
    Ok(())
}
