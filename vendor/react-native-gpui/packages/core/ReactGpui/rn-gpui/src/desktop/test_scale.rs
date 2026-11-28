//! The window scale factor a test run asks for, on the platforms whose backend
//! reads it from the environment.
//!
//! `RN_GPUI_TEST_SCALE_FACTOR` names the scale every window reports. macOS
//! applies it itself (gpui-fast's `scale_override`); the X11 backend of GPUI
//! reads `GPUI_X11_SCALE_FACTOR` instead, so on Linux the request is handed over
//! under that name before the backend starts. A value the caller set for the
//! backend wins.

/// Hands the requested scale to the platform backend. Call it before the
/// platform is created.
pub fn apply_to_environment() {
    #[cfg(target_os = "linux")]
    {
        let Some(scale) = std::env::var("RN_GPUI_TEST_SCALE_FACTOR")
            .ok()
            .and_then(|value| value.parse::<f32>().ok())
            .filter(|scale| scale.is_finite() && *scale > 0.0)
        else {
            return;
        };
        if std::env::var_os("GPUI_X11_SCALE_FACTOR").is_none() {
            std::env::set_var("GPUI_X11_SCALE_FACTOR", scale.to_string());
        }
    }
}
