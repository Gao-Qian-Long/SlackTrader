use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use std::sync::OnceLock;
use std::time::Duration;

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => { let _ = window.hide(); }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

#[tauri::command]
fn update_tray_tooltip(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let tray = app.tray_by_id("main-tray").ok_or_else(|| "tray icon unavailable".to_string())?;
    tray.set_tooltip(Some(text)).map_err(|error| error.to_string())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 BluetoothAssistant/0.1")
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client")
    })
}

#[tauri::command]
async fn fetch_market_json(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    match parsed.host_str() {
        Some("push2.eastmoney.com") | Some("push2his.eastmoney.com") => {}
        _ => return Err("market data host is not allowed".to_string()),
    }
    http_client()
        .get(parsed)
        .send().await.map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?
        .text().await.map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &quit])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("missing application icon").clone())
                .tooltip("蓝牙助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![update_tray_tooltip, fetch_market_json])
        .run(tauri::generate_context!())
        .expect("error while running bluetooth assistant");
}
