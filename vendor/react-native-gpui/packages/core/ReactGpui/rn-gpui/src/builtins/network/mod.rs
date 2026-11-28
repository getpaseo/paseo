//! `Network`: the proxy and DNS settings of the HTTP client that `fetch`,
//! `XMLHttpRequest` and GPUI's image and font loads share.

use std::sync::Mutex;

use rn_gpui_module::{ModuleError, ModuleThread};

use crate::builtins::rn_gpui_specs::{
    NativeGpuiNetworkEvents, NativeGpuiNetworkSpec, NetworkSettings,
};

#[derive(Clone, Default)]
struct Settings {
    mode: String,
    rules: String,
    bypass: String,
    dns_over_https: String,
}

static SETTINGS: Mutex<Option<Settings>> = Mutex::new(None);

fn current() -> Settings {
    SETTINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| Settings {
            mode: "system".to_string(),
            ..Settings::default()
        })
}

/// Hands the settings to the client, which checks the proxy rules.
fn apply(next: Settings) -> Result<(), ModuleError> {
    let error = rn_gpui_sys::ffi::rn_gpui_network_configure(
        &next.mode,
        &next.rules,
        &next.bypass,
        &next.dns_over_https,
    );
    if !error.is_empty() {
        return Err(ModuleError::new(error));
    }
    *SETTINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(next);
    Ok(())
}

/// The servers are one URL per line, and each has to be `https`, which is all
/// libcurl takes.
fn check_doh(urls: &str) -> Result<(), ModuleError> {
    for url in urls.lines().filter(|line| !line.is_empty()) {
        if !url.starts_with("https://") {
            return Err(ModuleError::new(format!(
                "a DNS-over-HTTPS URL must start with https://, got \"{url}\""
            )));
        }
    }
    Ok(())
}

struct NetworkModule;

impl NativeGpuiNetworkSpec for NetworkModule {
    const THREAD: ModuleThread = ModuleThread::Own;

    fn new(_events: NativeGpuiNetworkEvents) -> Self {
        Self
    }

    async fn set_proxy(
        &self,
        mode: String,
        rules: String,
        bypass: String,
    ) -> Result<(), ModuleError> {
        apply(Settings {
            mode,
            rules,
            bypass,
            ..current()
        })
    }

    async fn set_dns_over_https(&self, url: String) -> Result<(), ModuleError> {
        check_doh(&url)?;
        apply(Settings {
            dns_over_https: url,
            ..current()
        })
    }

    async fn get_settings(&self) -> Result<NetworkSettings, ModuleError> {
        let settings = current();
        Ok(NetworkSettings {
            mode: settings.mode,
            rules: settings.rules,
            bypass: settings.bypass,
            dns_over_https: settings.dns_over_https,
        })
    }

    async fn proxy_for_url(&self, url: String) -> Result<String, ModuleError> {
        Ok(rn_gpui_sys::ffi::rn_gpui_network_proxy_for(&url))
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_network_module::<NetworkModule>(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dns_over_https_url_has_to_be_https() {
        assert!(check_doh("").is_ok());
        assert!(check_doh("https://dns.example/dns-query").is_ok());
        assert!(check_doh("http://dns.example/dns-query").is_err());
        assert!(check_doh("https://a.example/q\nhttps://b.example/q").is_ok());
        assert!(check_doh("https://a.example/q\nhttp://b.example/q").is_err());
    }
}
