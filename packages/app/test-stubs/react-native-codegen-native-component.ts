// Test stub for react-native-gesture-handler's deep import, which bypasses the
// react-native → react-native-web alias and cannot bundle in the browser test.
// Only needed so the module graph resolves; no test drives a codegen'd native component.
export default function codegenNativeComponent(): null {
  return null;
}
