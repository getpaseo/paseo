// The test alias for `react-native` points here instead of straight at react-native-web, so the
// handful of exports the app uses but react-native-web does not implement (native-only toast
// module) resolve during tests. Types for react-native-web come from
// test-stubs/react-native-web.d.ts.
export * from "react-native-web";

export const ToastAndroid = {
  show: () => undefined,
  SHORT: "SHORT",
  LONG: "LONG",
  TOP: "TOP",
  BOTTOM: "BOTTOM",
  CENTER: "CENTER",
} as const;
