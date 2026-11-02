// The native stack header dispatches this upstream screen event to notify
// React Navigation that the user requested a native back action.
import { customDirectEventTypes } from 'react-native/Libraries/Renderer/shims/ReactNativeViewConfigRegistry';

customDirectEventTypes.topHeaderBackButtonClicked = {
  registrationName: 'onHeaderBackButtonClicked',
};

customDirectEventTypes.topWillAppear = { registrationName: 'onWillAppear' };
customDirectEventTypes.topWillDisappear = {
  registrationName: 'onWillDisappear',
};
customDirectEventTypes.topAppear = { registrationName: 'onAppear' };
customDirectEventTypes.topDisappear = { registrationName: 'onDisappear' };

export { customDirectEventTypes };
