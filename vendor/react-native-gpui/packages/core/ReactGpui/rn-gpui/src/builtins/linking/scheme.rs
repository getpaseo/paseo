//! Whether any installed app handles a URL's scheme, and the OS settings URL.

/// The scheme of `url`, lowercased, or `None` when there is none.
pub fn scheme_of(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once(':')?;
    let valid = !scheme.is_empty()
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then(|| scheme.to_ascii_lowercase())
}

#[cfg(target_os = "macos")]
pub fn can_open(url: &str) -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    if scheme_of(url).is_none() {
        return false;
    }
    // SAFETY: Foundation and AppKit calls with live receivers; `NSWorkspace`
    // may be asked from any thread for this query.
    unsafe {
        let text = NSString::alloc(nil).init_str(url);
        let ns_url: id = msg_send![class!(NSURL), URLWithString: text];
        if ns_url == nil {
            return false;
        }
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let handler: id = msg_send![workspace, URLForApplicationToOpenURL: ns_url];
        handler != nil
    }
}

#[cfg(target_os = "windows")]
pub fn can_open(url: &str) -> bool {
    use windows_sys::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCSTR_COMMAND};
    let Some(scheme) = scheme_of(url) else {
        return false;
    };
    let wide: Vec<u16> = scheme.encode_utf16().chain(std::iter::once(0)).collect();
    let mut size: u32 = 0;
    // SAFETY: `wide` is NUL-terminated; a null output buffer asks only for the size.
    let status = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_COMMAND,
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    status == 0 || status == 1 /* S_FALSE: the size was returned */
}

#[cfg(target_os = "linux")]
pub fn can_open(url: &str) -> bool {
    use std::process::Command;
    let Some(scheme) = scheme_of(url) else {
        return false;
    };
    let web = matches!(scheme.as_str(), "http" | "https");
    let output = if web {
        Command::new("xdg-settings")
            .args(["get", "default-web-browser"])
            .output()
    } else {
        Command::new("xdg-mime")
            .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
            .output()
    };
    let registered = output
        .map(|output| output.status.success() && !output.stdout.iter().all(u8::is_ascii_whitespace))
        .unwrap_or(false);
    registered || web && web_browser_fallback()
}

/// `xdg-open` opens a web address with `$BROWSER` or the distribution's
/// `x-www-browser` when no desktop entry is the default browser.
#[cfg(target_os = "linux")]
fn web_browser_fallback() -> bool {
    std::env::var_os("BROWSER").is_some_and(|browser| !browser.is_empty())
        || std::env::var_os("PATH").is_some_and(|path| {
            std::env::split_paths(&path).any(|dir| dir.join("x-www-browser").is_file())
        })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn can_open(_url: &str) -> bool {
    false
}

/// Opens the OS settings app, or says why it cannot.
pub fn open_settings(cx: &gpui::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        cx.open_url("x-apple.systempreferences:");
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        cx.open_url("ms-settings:");
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = cx;
        for program in [
            "gnome-control-center",
            "systemsettings",
            "xfce4-settings-manager",
        ] {
            if std::process::Command::new(program).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("no settings application was found on PATH".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = cx;
        Err("opening settings is not supported on this system".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scheme_is_the_part_before_the_first_colon() {
        assert_eq!(scheme_of("HTTPS://example.com").as_deref(), Some("https"));
        assert_eq!(scheme_of("mailto:a@b.c").as_deref(), Some("mailto"));
        assert_eq!(
            scheme_of("x-apple.systempreferences:").as_deref(),
            Some("x-apple.systempreferences")
        );
        assert_eq!(scheme_of("no scheme here"), None);
        assert_eq!(scheme_of("1http://x"), None);
        assert_eq!(scheme_of(":empty"), None);
    }

    #[test]
    fn a_known_scheme_has_a_handler_and_an_unregistered_one_does_not() {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            assert!(can_open("https://example.com"));
            assert!(!can_open("rngpui-no-such-scheme-zzz://x"));
        }
        assert!(!can_open("not a url"));
    }
}
