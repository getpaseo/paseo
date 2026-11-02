// RNGH's legacy handler path registers only the continuous event in its JS
// module. GPUI dispatches the codegen state-change event directly, so expose
// both direct-event registrations from this platform package.
import { customDirectEventTypes } from 'react-native/Libraries/Renderer/shims/ReactNativeViewConfigRegistry';

customDirectEventTypes.topGestureHandlerEvent = {
  registrationName: 'onGestureHandlerEvent',
};
customDirectEventTypes.topGestureHandlerStateChange = {
  registrationName: 'onGestureHandlerStateChange',
};

export { customDirectEventTypes };
