// RN's mobile base configs split accessibility props by OS. Desktop supports
// both sets, so do not silently drop Android-originated props on macOS.
// There is no public React Native export for BaseViewConfig.
// eslint-disable-next-line @react-native/no-deep-imports
import iosConfig from 'react-native/Libraries/NativeComponent/BaseViewConfig.ios';

export default {
  ...iosConfig,
  // A native `topContextMenu` event reaches the view's `onContextMenu` handler
  //. It is registered the same way RN registers `onPointerEnter`
  // (a bubbling event plus a `validAttributes` marker), because Fabric converts
  // the JS handler function into the boolean marker that creates the listener.
  bubblingEventTypes: {
    ...iosConfig.bubblingEventTypes,
    topContextMenu: {
      phasedRegistrationNames: {
        bubbled: 'onContextMenu',
        captured: 'onContextMenuCapture',
      },
    },
  },
  validAttributes: {
    ...iosConfig.validAttributes,
    accessibilityLabelledBy: true,
    accessibilityLiveRegion: true,
    importantForAccessibility: true,
    focusable: true,
    desktopDragRegion: true,
    onContextMenu: true,
    onContextMenuCapture: true,
    // RN omits iOS listener flags when Platform.OS is an out-of-tree platform.
    // Fabric's AccessibilityProps needs these flags for native action routing.
    onAccessibilityAction: true,
    onAccessibilityEscape: true,
    onAccessibilityTap: true,
  },
};
