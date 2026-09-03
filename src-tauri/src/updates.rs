use std::time::Duration;
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

fn routes(mode: &str) -> Result<Vec<&'static str>, &'static str> {
    match mode {
        "auto" => Ok(vec!["direct", "system"]),
        "direct" => Ok(vec!["direct"]),
        "system" => Ok(vec!["system"]),
        _ => Err("INVALID_NETWORK_MODE"),
    }
}

fn error_code(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(e) if e.is_timeout() => "NETWORK_TIMEOUT",
        Error::Reqwest(_) | Error::Network(_) => "NETWORK_FAILED",
        Error::ReleaseNotFound => "MANIFEST_UNAVAILABLE",
        Error::Serialization(_) | Error::Semver(_) => "MANIFEST_INVALID",
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "PLATFORM_MISSING",
        _ => "UPDATE_CHECK_FAILED",
    }
}

/// Use the official updater resource and signature verifier; only routing changes.
#[tauri::command]
pub async fn check_app_update(webview: Webview, mode: String) -> Result<serde_json::Value, serde_json::Value> {
    let candidates = routes(&mode).map_err(|code| serde_json::json!({ "code": code }))?;
    let mut failures = Vec::new();
    for route in candidates {
        let mut builder = webview.updater_builder().timeout(Duration::from_secs(20));
        if route == "direct" { builder = builder.no_proxy(); }
        let updater = builder.build().map_err(|e| serde_json::json!({ "code": error_code(&e) }))?;
        match updater.check().await {
            Ok(Some(update)) => {
                let mut metadata = serde_json::json!({
                    "currentVersion": update.current_version,
                    "version": update.version,
                    "body": update.body,
                    "rawJson": update.raw_json
                });
                metadata["rid"] = serde_json::json!(webview.resources_table().add(update));
                return Ok(serde_json::json!({ "update": metadata, "route": route }));
            }
            Ok(None) => return Ok(serde_json::json!({ "update": null, "route": route })),
            Err(error) => failures.push(serde_json::json!({ "route": route, "code": error_code(&error) })),
        }
    }
    Err(serde_json::json!({ "code": failures.last().and_then(|v| v["code"].as_str()).unwrap_or("UPDATE_CHECK_FAILED"), "attempts": failures }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_routes_are_bounded_and_explicit() {
        assert_eq!(routes("auto").unwrap(), vec!["direct", "system"]);
        assert_eq!(routes("direct").unwrap(), vec!["direct"]);
        assert_eq!(routes("system").unwrap(), vec!["system"]);
        assert!(routes("http://example.test").is_err());
    }
    #[test]
    fn update_errors_do_not_expose_private_urls() {
        assert_eq!(error_code(&tauri_plugin_updater::Error::ReleaseNotFound), "MANIFEST_UNAVAILABLE");
        assert_eq!(error_code(&tauri_plugin_updater::Error::Network("private proxy detail".into())), "NETWORK_FAILED");
    }
}
