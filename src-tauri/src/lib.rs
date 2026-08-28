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
            .user_agent("Mozilla/5.0 BluetoothAssistant/0.3")
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client")
    })
}

#[tauri::command]
async fn fetch_market_json(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    if !allowed_market_url(&parsed) { return Err("行情地址不在白名单".into()); }
    let host = parsed.host_str().unwrap_or_default().to_owned();
    let referer = if host == "hq.sinajs.cn" { "https://finance.sina.com.cn/" }
        else if host.ends_with("gtimg.cn") { "https://gu.qq.com/" }
        else if host == "d.10jqka.com.cn" { "https://q.10jqka.com.cn/" }
        else { "https://quote.eastmoney.com/" };
    let response = http_client().get(parsed).header("Referer", referer)
        .send().await.map_err(|e| if e.is_timeout() { "请求超时（10秒）".to_string() }
            else if e.is_connect() { format!("连接失败：{e}") } else { format!("传输中断：{e}") })?;
    let status = response.status();
    if !status.is_success() {
        let wait_ms = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(|v| {
            v.parse::<u64>().ok().map(|seconds| seconds.saturating_mul(1000)).or_else(|| {
                httpdate::parse_http_date(v).ok().map(|time| time.duration_since(std::time::SystemTime::now()).unwrap_or_default().as_millis() as u64)
            }).unwrap_or(300_000)
        }).unwrap_or(if status.as_u16() == 429 { 300_000 } else { 0 });
        return Err(format!("HTTP {}{}; retryAfterMs={}", status.as_u16(), if status.as_u16() == 429 { "（请求限流）" } else { "" }, wait_ms));
    }
    let bytes = response.bytes().await.map_err(|e| format!("读取行情失败：{e}"))?;
    if bytes.len() > 2_000_000 { return Err("行情响应过大".into()); }
    if host == "qt.gtimg.cn" || host == "hq.sinajs.cn" {
        let (text, errors) = encoding_rs::GBK.decode_without_bom_handling(&bytes);
        if errors { return Err("行情GBK编码异常".into()); }
        Ok(text.into_owned())
    } else { String::from_utf8(bytes.to_vec()).map_err(|_| "行情UTF-8编码异常".into()) }
}

fn allowed_market_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(443) { return false; }
    match url.host_str().unwrap_or_default() {
        "push2.eastmoney.com" => url.path() == "/api/qt/stock/get",
        "push2his.eastmoney.com" => matches!(url.path(), "/api/qt/stock/trends2/get" | "/api/qt/stock/kline/get"),
        "qt.gtimg.cn" => url.path().strip_prefix("/q=").is_some_and(valid_quote_code),
        "hq.sinajs.cn" => url.path().strip_prefix("/list=").is_some_and(valid_quote_code),
        "web.ifzq.gtimg.cn" => matches!(url.path(), "/appstock/app/minute/query" | "/appstock/app/fqkline/get"),
        "d.10jqka.com.cn" => allowed_ths_path(url.path()),
        _ => false,
    }
}

fn allowed_ths_path(path: &str) -> bool {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.len() < 4 || !matches!(parts[0], "v6" | "v4") { return false; }
    let id = parts[2];
    if id.len() != 9 || !id.starts_with("bk_") || !id.as_bytes()[3..].iter().all(u8::is_ascii_digit) { return false; }
    match parts[1] {
        "realhead" => parts[0] == "v6" && parts.len() == 4 && parts[3] == "last.js",
        "time" => parts.len() == 4 && parts[3] == "last.js",
        "line" => parts.len() == 5 && parts[3] == "01" && matches!(parts[4], "last.js" | "today.js"),
        _ => false,
    }
}

fn valid_quote_code(code: &str) -> bool {
    code.len() == 8 && ["sh", "sz", "bj"].iter().any(|prefix| code.starts_with(prefix)) && code.as_bytes()[2..].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ths_allowlist() {
        for path in ["/v6/realhead/bk_881129/last.js", "/v6/time/bk_881129/last.js", "/v4/time/bk_881129/last.js", "/v6/line/bk_881129/01/last.js", "/v4/line/bk_881129/01/today.js"] {
            assert!(allowed_market_url(&reqwest::Url::parse(&format!("https://d.10jqka.com.cn{path}")).unwrap()));
        }
        for path in ["/v6/time/881129/last.js", "/v6/time/bk_88112x/last.js", "/v6/line/bk_881129/02/last.js", "/v4/realhead/bk_881129/last.js", "/v6/time/bk_881129/last.js/extra", "/v6/time/bk_881129"] {
            assert!(!allowed_ths_path(path));
        }
        assert!(!allowed_market_url(&reqwest::Url::parse("https://d.10jqka.com.cn.evil.test/v6/time/bk_881129/last.js").unwrap()));
    }
    #[test]
    #[ignore = "explicit live sector network verification only"]
    fn live_sector_endpoints() {
        tauri::async_runtime::block_on(async {
            for (label,path) in [
                ("ths-quote", "v6/realhead/bk_881129/last.js"),
                ("ths-minute", "v6/time/bk_881129/last.js"),
                ("ths-minute-v4", "v4/time/bk_881129/last.js"),
                ("ths-daily", "v6/line/bk_881129/01/last.js"),
                ("ths-today", "v6/line/bk_881129/01/today.js"),
                ("ths-daily-v4", "v4/line/bk_881129/01/last.js"),
                ("ths-today-v4", "v4/line/bk_881129/01/today.js"),
            ] {
                let body = fetch_market_json(format!("https://d.10jqka.com.cn/{path}")).await.expect(label);
                assert!(body.starts_with("quotebridge_") && body.contains("881129"), "{label}: wrong response");
                if let Ok(dir) = std::env::var("MARKET_LIVE_OUTPUT") {
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(std::path::Path::new(&dir).join(format!("{label}.txt")), &body).unwrap();
                }
                println!("LIVE PASS {label}: {} bytes",body.len());
            }
        });
    }
    #[test]
    fn market_allowlist() {
        for url in ["https://qt.gtimg.cn/q=sh603118", "https://hq.sinajs.cn/list=sh603118", "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh603118"] {
            assert!(allowed_market_url(&reqwest::Url::parse(url).unwrap()));
        }
        for url in ["http://qt.gtimg.cn/q=sh603118", "https://qt.gtimg.cn.evil.test/", "https://qt.gtimg.cn:444/", "https://user:pass@qt.gtimg.cn/", "https://web.ifzq.gtimg.cn/other"] {
            assert!(!allowed_market_url(&reqwest::Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn gbk_stock_name() {
        let (text, errors) = encoding_rs::GBK.decode_without_bom_handling(&[0xb9,0xb2,0xbd,0xf8,0xb9,0xc9,0xb7,0xdd]);
        assert_eq!(text, "共进股份"); assert!(!errors);
    }
    #[test]
    #[ignore = "explicit live network verification only"]
    fn live_backup_endpoints() {
        tauri::async_runtime::block_on(async {
            for (label,url,expected) in [
                ("tencent quote", "https://qt.gtimg.cn/q=sh603118", "共进股份"),
                ("sina quote", "https://hq.sinajs.cn/list=sh603118", "共进股份"),
                ("tencent minute", "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh603118", "sh603118"),
                ("tencent daily", "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh603118,day,,,90,qfq", "qfqday"),
            ] {
                let body = fetch_market_json(url.into()).await.expect(label);
                assert!(body.contains(expected), "{label}: unexpected response");
                if let Ok(dir) = std::env::var("MARKET_LIVE_OUTPUT") {
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(std::path::Path::new(&dir).join(format!("{}.txt",label.replace(' ', "-"))), &body).unwrap();
                }
                println!("LIVE PASS {label}: decoded {} bytes", body.len());
            }
        });
    }
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
