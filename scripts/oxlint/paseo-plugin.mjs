// Repo-specific oxlint rules. Each rule is its own name, so its burn-down list in .oxlintrc.json
// is one override that cannot interact with the `no-restricted-imports` burn-downs.

const PRESS_PRIMITIVE_SOURCES = new Set(["react-native", "react-native-gesture-handler"]);
const PRESS_PRIMITIVE_NAMES = new Set([
  "Pressable",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableOpacity",
  "TouchableWithoutFeedback",
]);

export const NO_RAW_PRESSABLE_MESSAGE =
  "A raw pressable has no standard press or hover feedback. Icon actions use ToolbarButton " +
  "(@/components/ui/pane-content-toolbar); rows on a menu surface use MenuItem or " +
  "ComposerTrackRow; other rows use PressHighlight (@/components/ui/press-highlight); labelled " +
  "buttons use Button. See docs/design.md §2.";

const noRawPressable = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!PRESS_PRIMITIVE_SOURCES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            PRESS_PRIMITIVE_NAMES.has(specifier.imported.name)
          ) {
            context.report({ node: specifier, message: NO_RAW_PRESSABLE_MESSAGE });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "paseo" },
  rules: {
    "no-raw-pressable": noRawPressable,
  },
};
