//! The host operating system's version as a string, for `Platform.Version`.

/// `15.1` from `sw_vers -productVersion` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_product_version(output: &str) -> Option<String> {
    let version = output.trim();
    (!version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .then(|| version.to_string())
}

/// The `VERSION_ID` of an os-release file, unquoted.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_os_release(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let value = line.strip_prefix("VERSION_ID=")?;
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_version(major: u32, minor: u32, build: u32) -> String {
    format!("{major}.{minor}.{build}")
}

#[cfg(target_os = "macos")]
fn detect() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    parse_product_version(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "linux")]
fn detect() -> Option<String> {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|contents| parse_os_release(&contents))
        .or_else(|| {
            std::fs::read_to_string("/proc/sys/kernel/osrelease")
                .ok()
                .map(|release| release.trim().to_string())
                .filter(|release| !release.is_empty())
        })
}

#[cfg(target_os = "windows")]
fn detect() -> Option<String> {
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }
    let mut info = OsVersionInfo {
        size: std::mem::size_of::<OsVersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    // SAFETY: `info` is a valid, correctly sized OSVERSIONINFOW.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status >= 0).then(|| windows_version(info.major, info.minor, info.build))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn detect() -> Option<String> {
    None
}

/// Resolved once: the version cannot change while the app runs.
pub fn os_version() -> String {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| detect().unwrap_or_else(|| "unknown".to_string()))
        .clone()
}

/// Whether the e2e test driver is attached to this process.
pub fn is_testing() -> bool {
    std::env::var("RN_GPUI_TEST_DRIVER").as_deref() == Ok("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_macos_product_version_keeps_its_dots() {
        assert_eq!(parse_product_version("15.1\n").as_deref(), Some("15.1"));
        assert_eq!(parse_product_version("15.1.1\n").as_deref(), Some("15.1.1"));
        assert_eq!(parse_product_version("garbage"), None);
        assert_eq!(parse_product_version(""), None);
    }

    #[test]
    fn a_linux_version_id_is_read_unquoted() {
        let release = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\n";
        assert_eq!(parse_os_release(release).as_deref(), Some("24.04"));
        assert_eq!(parse_os_release("VERSION_ID=12\n").as_deref(), Some("12"));
        assert_eq!(parse_os_release("NAME=Arch\n"), None);
    }

    #[test]
    fn a_windows_version_is_major_minor_build() {
        assert_eq!(windows_version(10, 0, 26100), "10.0.26100");
    }

    #[test]
    fn the_detected_version_is_never_empty() {
        let version = os_version();
        assert!(!version.is_empty());
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        assert_ne!(version, "unknown");
    }
}
