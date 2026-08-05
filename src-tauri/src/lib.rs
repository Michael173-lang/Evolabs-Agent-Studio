mod agent_models;
mod commands;
mod comfyui_manager;
mod runtime_manager;
mod storage_manager;
mod video_providers;

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
            commands::review_render_scene,
            commands::reveal_render_output,
            commands::get_agent_runtime,
            commands::run_agent_stage,
            commands::run_agent_plan,
            agent_models::get_agent_models,
            agent_models::test_agent_model,
            agent_models::run_agent_conversation,
            agent_models::run_agent_stage_v3,
            agent_models::run_agent_stage_v2,
            video_providers::get_video_provider_status,
            video_providers::configure_comfyui_provider,
            video_providers::clear_video_provider,
            comfyui_manager::get_managed_comfyui_status,
            comfyui_manager::install_managed_comfyui,
            comfyui_manager::repair_managed_comfyui,
            comfyui_manager::start_managed_comfyui,
            comfyui_manager::stop_managed_comfyui,
            comfyui_manager::uninstall_managed_comfyui,
            storage_manager::get_storage_overview,
            storage_manager::remove_storage_item,
            storage_manager::remove_old_model_versions,
            storage_manager::reveal_storage_item,
            commands::check_app_update,
            commands::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Evolabs");
}
