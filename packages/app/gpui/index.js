/* oxlint-disable import/no-unassigned-import -- Install globals before app modules evaluate. */
import "./adapters/intl";
import "../src/polyfills/install-early";
import "../src/styles/unistyles";
import { AppRegistry } from "react-native";
import { RootApp } from "../src/root-app";

// GPUI owns the native surface. Keep Paseo's full router and providers, while
// leaving Expo's mobile registration and WebView-based dev overlay out.
AppRegistry.registerComponent("Paseo", () => RootApp);
