//! `I18nManager`: the layout direction a surface starts with.
//!
//! The three flags live in a JSON file next to the window state and are read on
//! every use, so a change takes effect on the next load, as on iOS.

use std::path::PathBuf;

use rn_gpui_module::{ModuleError, ModuleThread};

use crate::builtins::rn_gpui_specs::{
    I18nManagerConstants, NativeGpuiI18nManagerEvents, NativeGpuiI18nManagerSpec,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Settings {
    pub allow_rtl: bool,
    pub force_rtl: bool,
    pub swap_left_and_right: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            allow_rtl: true,
            force_rtl: false,
            swap_left_and_right: true,
        }
    }
}

impl Settings {
    fn from_json(text: &str) -> Self {
        let mut settings = Self::default();
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return settings;
        };
        let flag = |key: &str, slot: &mut bool| {
            if let Some(read) = value.get(key).and_then(serde_json::Value::as_bool) {
                *slot = read;
            }
        };
        flag("allowRTL", &mut settings.allow_rtl);
        flag("forceRTL", &mut settings.force_rtl);
        flag("swapLeftAndRightInRTL", &mut settings.swap_left_and_right);
        settings
    }

    fn to_json(self) -> String {
        serde_json::json!({
            "allowRTL": self.allow_rtl,
            "forceRTL": self.force_rtl,
            "swapLeftAndRightInRTL": self.swap_left_and_right,
        })
        .to_string()
    }

    /// Whether surfaces lay out right to left for a locale.
    pub fn is_rtl(self, locale: &str) -> bool {
        self.force_rtl || (self.allow_rtl && locale_is_rtl(locale))
    }
}

/// Languages written right to left, by their primary subtag.
const RTL_LANGUAGES: &[&str] = &[
    "ar", "he", "iw", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb",
];

/// Scripts written right to left, by ISO 15924 code.
const RTL_SCRIPTS: &[&str] = &["Arab", "Hebr", "Thaa", "Syrc", "Nkoo"];

pub(crate) fn locale_is_rtl(locale: &str) -> bool {
    let mut subtags = locale.split(['-', '_', '.', '@']);
    let language = subtags.next().unwrap_or_default().to_ascii_lowercase();
    if let Some(script) = subtags.find(|subtag| subtag.len() == 4) {
        return RTL_SCRIPTS
            .iter()
            .any(|rtl| rtl.eq_ignore_ascii_case(script));
    }
    match language.as_str() {
        // Kurdish is written in Arabic script only in its Sorani form.
        "ku" => locale.to_ascii_lowercase().contains("arab"),
        language => RTL_LANGUAGES.contains(&language),
    }
}

fn settings_path() -> PathBuf {
    let app_id = crate::desktop::snapshot_app_id();
    let safe_id = crate::desktop::app_dir::safe_id(&app_id);
    let path = crate::desktop::app_dir::app_dir().join(format!("{safe_id}-i18n.json"));
    #[cfg(feature = "visual-capture")]
    if let Some(window_state) = std::env::var_os("RN_GPUI_WINDOW_STATE") {
        return PathBuf::from(window_state).with_extension("i18n.json");
    }
    path
}

fn load() -> Settings {
    std::fs::read_to_string(settings_path())
        .map(|text| Settings::from_json(&text))
        .unwrap_or_default()
}

fn update(change: impl FnOnce(&mut Settings)) {
    if let Err(error) = try_update(change) {
        log::warn!("I18nManager: could not save settings: {error}");
    }
}

fn try_update(change: impl FnOnce(&mut Settings)) -> std::io::Result<()> {
    let mut settings = load();
    change(&mut settings);
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, settings.to_json())
}

fn locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string())
}

/// What a new surface's layout needs: right to left, and whether left and right
/// swap in that direction.
pub(crate) fn layout_direction() -> (bool, bool) {
    let settings = load();
    let rtl = settings.is_rtl(&locale());
    RTL_ACTIVE.store(rtl, std::sync::atomic::Ordering::Relaxed);
    (rtl, settings.swap_left_and_right)
}

/// The direction the newest surface started with, for text alignment.
static RTL_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn rtl_active() -> bool {
    RTL_ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

struct I18nManagerModule;

impl NativeGpuiI18nManagerSpec for I18nManagerModule {
    const THREAD: ModuleThread = ModuleThread::Own;

    fn new(_events: NativeGpuiI18nManagerEvents) -> Self {
        Self
    }

    fn get_constants(&self) -> Result<I18nManagerConstants, ModuleError> {
        let (is_rtl, _) = layout_direction();
        let settings = load();
        let locale = locale();
        Ok(I18nManagerConstants {
            is_rtl,
            do_left_and_right_swap_in_rtl: settings.swap_left_and_right,
            locale_identifier: locale,
        })
    }

    fn allow_rtl(&self, allow_rtl: bool) {
        update(|settings| settings.allow_rtl = allow_rtl)
    }

    fn force_rtl(&self, force_rtl: bool) {
        update(|settings| settings.force_rtl = force_rtl)
    }

    fn swap_left_and_right_in_rtl(&self, swap_left_and_right: bool) {
        update(|settings| settings.swap_left_and_right = swap_left_and_right)
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_i18n_manager_module::<I18nManagerModule>(),
    );
    let _ = rn_gpui_sys::LAYOUT_DIRECTION_HANDLER.set(Box::new(layout_direction));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn right_to_left_languages_and_scripts_are_recognised() {
        for locale in [
            "ar", "ar-EG", "he_IL", "fa-IR", "ur-PK", "ps", "yi", "dv", "ckb-IQ",
        ] {
            assert!(locale_is_rtl(locale), "{locale}");
        }
        for locale in ["en-US", "de", "ja-JP", "zh-Hans", "ku-Latn", "sr-Latn"] {
            assert!(!locale_is_rtl(locale), "{locale}");
        }
        assert!(locale_is_rtl("ku-Arab"));
        assert!(locale_is_rtl("az-Arab"));
        assert!(locale_is_rtl("en-Arab"));
    }

    #[test]
    fn force_overrides_the_locale_and_allow_gates_it() {
        let mut settings = Settings::default();
        assert!(settings.is_rtl("ar"));
        assert!(!settings.is_rtl("en"));
        settings.force_rtl = true;
        assert!(settings.is_rtl("en"));
        settings.force_rtl = false;
        settings.allow_rtl = false;
        assert!(!settings.is_rtl("ar"));
    }

    #[test]
    fn settings_round_trip_and_ignore_garbage() {
        let settings = Settings {
            allow_rtl: false,
            force_rtl: true,
            swap_left_and_right: false,
        };
        assert_eq!(Settings::from_json(&settings.to_json()), settings);
        assert_eq!(Settings::from_json("not json"), Settings::default());
        assert_eq!(Settings::from_json("{\"forceRTL\":true}").force_rtl, true);
    }
}
