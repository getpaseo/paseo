//! The display a window is on and the system's text scale, for `Dimensions`.

use gpui::{App, Window};

/// The system text scale. A test build can pin it with `RN_GPUI_TEST_FONT_SCALE`.
pub fn system_font_scale() -> f32 {
    #[cfg(feature = "test-driver")]
    if let Some(scale) = std::env::var("RN_GPUI_TEST_FONT_SCALE")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|scale| *scale > 0.0)
    {
        return scale;
    }
    os_font_scale()
}

/// The user's text size preference as a multiplier; `1.0` where the OS has none.
#[cfg(target_os = "windows")]
fn os_font_scale() -> f32 {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let subkey: Vec<u16> = "Software\\Microsoft\\Accessibility\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "TextScaleFactor\0".encode_utf16().collect();
    let mut percent: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated and `percent` is a valid DWORD slot
    // of `size` bytes.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut percent as *mut u32).cast(),
            &mut size,
        )
    };
    if status == 0 {
        parse_percent(percent)
    } else {
        1.0
    }
}

#[cfg(target_os = "linux")]
fn os_font_scale() -> f32 {
    std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "text-scaling-factor"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_factor(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or(1.0)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn os_font_scale() -> f32 {
    1.0
}

/// A registry percentage (`150`) as a multiplier, bounded to what a UI can lay out.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_percent(percent: u32) -> f32 {
    (percent as f32 / 100.0).clamp(0.5, 4.0)
}

/// `gsettings` prints a bare number, or `uint32 1.25`-style for some types.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_factor(output: &str) -> Option<f32> {
    let factor: f32 = output.split_whitespace().last()?.parse().ok()?;
    (factor.is_finite() && factor > 0.0).then(|| factor.clamp(0.5, 4.0))
}

/// The size of the display `window` is on, in points.
pub fn display_size(window: &Window, cx: &App) -> Option<(f32, f32)> {
    let display = window.display(cx).or_else(|| cx.primary_display())?;
    let size = display.bounds().size;
    Some((f32::from(size.width), f32::from(size.height)))
}

/// Tells `Dimensions` the display and text scale `window` sees now.
pub fn report(window: &Window, cx: &App, host: &crate::host::Host) {
    let Some((width, height)) = display_size(window, cx) else {
        return;
    };
    host.set_display_metrics(width, height, system_font_scale());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_percentage_becomes_a_multiplier() {
        assert_eq!(parse_percent(100), 1.0);
        assert_eq!(parse_percent(150), 1.5);
        assert_eq!(parse_percent(0), 0.5);
        assert_eq!(parse_percent(10_000), 4.0);
    }

    #[test]
    fn gsettings_output_is_read_as_a_factor() {
        assert_eq!(parse_factor("1.25\n"), Some(1.25));
        assert_eq!(parse_factor("uint32 2\n"), Some(2.0));
        assert_eq!(parse_factor("garbage"), None);
        assert_eq!(parse_factor("-1"), None);
    }
}
