mod commands;
mod runtime_manager;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::PendingAppUpdate(std::sync::Mutex::new(None)))
        .plugin(tauri_plugin_single_instance::init(
            |app, _args, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_hardware_profile,
            commands::load_last_project,
            commands::save_project,
            commands::import_reference_asset,
            commands::read_local_image,
            commands::start_runtime_setup,
            commands::start_ai_runtime_setup,
            commands::get_ai_runtime_setup,
            commands::start_model_install,
            commands::get_model_install,
            commands::control_model_install,
            commands::start_render_job,
            commands::get_render_job,
            commands::control_render_job,
            commands::reveal_render_output,
            commands::get_agent_runtime,
            commands::run_agent_stage,
            commands::run_agent_plan,
            commands::check_app_update,
            commands::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Evolabs");
}
