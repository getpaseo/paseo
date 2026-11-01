// react-native-web ships these style helpers without declarations; reanimated-web-utils.ts
// imports them for the browser test project.
declare module "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle" {
  const createReactDOMStyle: (style: Record<string, unknown>) => Record<string, unknown>;
  export default createReactDOMStyle;
}
declare module "react-native-web/dist/exports/StyleSheet/preprocess" {
  export const createTransformValue: (transform: unknown) => string;
  export const createTextShadowValue: (style: Record<string, unknown>) => string | undefined;
}
