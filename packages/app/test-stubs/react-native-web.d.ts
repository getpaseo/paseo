// react-native-web ships no type declarations. The test alias module re-exports its runtime as
// `react-native`, whose real types are the closest surface — the runtime implements that API.
declare module "react-native-web" {
  export * from "react-native";
}
