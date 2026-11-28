---
id: navigation
title: Navigating Between Screens
---

[React Navigation](https://reactnavigation.org) works on desktop with its native stack. Follow React Native's [navigation guide](https://reactnative.dev/docs/0.87/navigation) and the [React Navigation getting started guide](https://reactnavigation.org/docs/getting-started); this page lists only what is different on desktop.

## Installation

Install the desktop packages next to React Navigation's peer dependencies:

```shell
npm install @react-navigation/native @react-navigation/native-stack
npm install react-native-screens react-native-safe-area-context
npm install @react-native-gpui/screens @react-native-gpui/safe-area-context
```

See [Supported libraries](https://streetwriters.github.io/react-native-gpui/docs/supported-libraries) for the versions that the desktop packages support. Autolinking builds the native code, so there is no extra linking step. Run the app with `npx react-native run-desktop`.

## The native stack

The `native-stack` navigator is drawn by react-native-gpui through `react-native-screens`, so the same code runs on macOS, Windows and Linux.

## Mouse back and forward buttons

The back button fires `BackHandler`'s `hardwareBackPress`, which React Navigation already handles. The forward button moves forward in a stack with `useDesktopForwardNavigation` from `@react-native-gpui/core/navigation`:

```tsx
import { useDesktopForwardNavigation } from '@react-native-gpui/core/navigation';

function App() {
  const navigationRef = useNavigationContainerRef();
  useDesktopForwardNavigation(navigationRef);
  return (
    <NavigationContainer ref={navigationRef}>{/* ... */}</NavigationContainer>
  );
}
```
