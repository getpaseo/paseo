//! Components react-native-screens ships that this platform does not implement.
//!
//! They are named here so the module can say so once, instead of core carrying a
//! list of a library's components.
/// Whether this component is one the platform cannot render.
pub fn unsupported_component(name: &str) -> bool {
    matches!(
        name,
        "RNSSearchBar"
            | "RNSBottomTabs"
            | "RNSBottomTabsScreen"
            | "RNSScreenFooter"
            | "RNSSplitView"
            | "RNSSplitViewScreen"
    ) || name.starts_with("RNSSplitView")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_the_components_the_platform_cannot_render() {
        for name in [
            "RNSSearchBar",
            "RNSBottomTabs",
            "RNSBottomTabsScreen",
            "RNSScreenFooter",
            "RNSSplitView",
            "RNSSplitViewScreen",
        ] {
            assert!(unsupported_component(name), "{name} should be unsupported");
        }
        assert!(unsupported_component("RNSSplitViewSomethingElse"));
        for name in ["RNSScreen", "RNSScreenStack", "View", "RNSScreenContainer"] {
            assert!(!unsupported_component(name), "{name} should be supported");
        }
    }
}
