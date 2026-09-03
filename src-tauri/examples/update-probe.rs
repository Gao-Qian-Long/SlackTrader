use std::{env, fs, time::Duration};
use tauri_plugin_updater::UpdaterExt;

/// Headless verification: no windows/tray, no installation, no user data writes.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 { return Err("Usage: update-probe CURRENT_VERSION direct|system [DOWNLOAD_OUTPUT]".into()); }
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.slacktrader.updater-probe".into();
    context.package_info_mut().version = args[1].parse()?;
    let app = tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build()).build(context)?;
    tauri::async_runtime::block_on(async {
        let mut builder = app.updater_builder().timeout(Duration::from_secs(20));
        match args[2].as_str() { "direct" => builder = builder.no_proxy(), "system" => {}, _ => return Err("Invalid route".into()) }
        let updater = builder.build()?;
        match updater.check().await? {
            Some(mut update) => {
                println!("PROBE_CHECK=PASS from={} to={} route={}", args[1], update.version, args[2]);
                if let Some(output) = args.get(3) {
                    update.timeout = Some(Duration::from_secs(300));
                    let bytes = update.download(|_, _| {}, || {}).await?;
                    fs::write(output, &bytes)?;
                    println!("PROBE_DOWNLOAD=PASS bytes={} signature=verified install=not-invoked", bytes.len());
                }
            }
            None => println!("PROBE_CHECK=PASS from={} result=current route={}", args[1], args[2]),
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
