// react-native-web renders the `dataSet` prop to `data-*` attributes on the DOM
// node, but the bundled react-native types don't declare it. Augment View/Text
// props so code surfaces can carry a marker for the web interface-font rule
// (see styles/code-surface.ts and screens/settings/appearance/apply-root-font.web.ts).
import "react-native";

declare module "react-native" {
  interface ViewProps {
    dataSet?: Record<string, string | number | boolean | undefined>;
  }
  interface TextProps {
    dataSet?: Record<string, string | number | boolean | undefined>;
  }
}
