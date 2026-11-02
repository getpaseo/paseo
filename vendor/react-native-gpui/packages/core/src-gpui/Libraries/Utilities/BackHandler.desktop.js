/**
 * Desktop BackHandler backed by GPUI's generic device event bridge.
 * Unlike Android, an unhandled back press never exits a desktop app.
 */
import { DeviceEventEmitter } from 'react-native';

const subscriptions = [];

DeviceEventEmitter.addListener('hardwareBackPress', nativeEvent => {
  const event = {
    type: 'hardwareBackPress',
    timeStamp: nativeEvent?.timeStamp ?? Date.now(),
  };

  for (let index = subscriptions.length - 1; index >= 0; index--) {
    if (subscriptions[index]?.(event)) {
      return;
    }
  }
});

const BackHandler = {
  exitApp() {},

  addEventListener(eventName, handler) {
    if (eventName !== 'hardwareBackPress') {
      return { remove() {} };
    }

    if (!subscriptions.includes(handler)) {
      subscriptions.push(handler);
    }

    return {
      remove() {
        const index = subscriptions.indexOf(handler);
        if (index !== -1) {
          subscriptions.splice(index, 1);
        }
      },
    };
  },
};

export default BackHandler;
