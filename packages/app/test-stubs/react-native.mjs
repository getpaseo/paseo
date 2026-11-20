// react-native-web has no ToastAndroid. The toast host imports it by name for its Android
// branch; Metro and Node tolerate the missing binding, but browser tests load native ESM,
// which rejects the import and fails every module that reaches the toast context.
export * from "react-native-web/dist/index.js";

export const ToastAndroid = {
  SHORT: 0,
  LONG: 1,
  TOP: 0,
  BOTTOM: 1,
  CENTER: 2,
  show() {},
  showWithGravity() {},
};
