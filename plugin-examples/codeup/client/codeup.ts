import {
  defineForgeClientProvider,
  defineForgeFacts,
  type PluginForgeMergeCapability,
} from "@getpaseo/plugin";
import { CodeupMergeFactsSchema, type CodeupMergeFacts } from "../shared/codeup-facts";
import { codeupDefinition } from "../shared/codeup-definition";

const CODEUP_ICON_PATH =
  "M12 1.5A10.5 10.5 0 1 0 20.07 18.72l-3.18-3.18A6 6 0 1 1 16.31 8l3.62-2.72A10.47 10.47 0 0 0 12 1.5Zm7.5 2.25a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z";

const CODEUP_MERGE_METHODS = ["merge", "squash", "rebase"] as const;

function deriveCodeupMergeCapability(codeup: CodeupMergeFacts): PluginForgeMergeCapability {
  return {
    directMergeReady:
      codeup.status === "TO_BE_MERGED" &&
      codeup.allRequirementsPass &&
      Object.values(codeup.requirementChecks).every((check) => check !== false),
    canEnableAutoMerge: false,
    autoMergeEnabled: false,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
    allowedMethods: [...CODEUP_MERGE_METHODS],
    preferredMethod: null,
  };
}

export const codeupClientProvider = defineForgeClientProvider({
  definition: codeupDefinition,
  facts: defineForgeFacts({
    family: "codeup",
    schema: CodeupMergeFactsSchema,
    deriveMergeCapability: deriveCodeupMergeCapability,
  }),
  view: {
    icon: {
      kind: "svg-path",
      viewBox: [0, 0, 24, 24],
      path: CODEUP_ICON_PATH,
    },
    brandColor: {
      light: "#FF6A00",
      dark: "#FF6A00",
    },
  },
});
