// Reanimated's web build loads these from react-native-web with `require`, which the browser
// test bundle does not have. They stayed undefined and every animated style update threw, so a
// browser test that toggles a real Switch failed with unhandled errors. The same functions, as
// ES module imports.
export { default as createReactDOMStyle } from "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle";
export {
  createTextShadowValue,
  createTransformValue,
} from "react-native-web/dist/exports/StyleSheet/preprocess";
