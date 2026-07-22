import { z } from "zod";
import {
  defineForgeFacts,
  defineNativeFallbackCheck,
  GITEA_FAMILY_URL_GRAMMAR,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { CHECK_TRAIT_WARNING } from "@getpaseo/protocol/check-traits";
import { mapGiteaCommitState } from "@getpaseo/protocol/gitea-status";

const GiteaMergeFactsSchema = z
  .object({
    forge: z.literal("gitea"),
    mergeable: z.boolean().optional().default(false),
    hasMerged: z.boolean().optional().default(false),
    ciStatus: z.string().nullable().optional().default(null),
  })
  .passthrough();

type GiteaMergeFacts = z.infer<typeof GiteaMergeFactsSchema>;

const GITEA_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash", "rebase"];

function deriveGiteaMergeCapability(gitea: GiteaMergeFacts): MergeCapability {
  return {
    directMergeReady: gitea.mergeable && !gitea.hasMerged,
    canEnableAutoMerge: false,
    autoMergeEnabled: false,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
    allowedMethods: GITEA_MERGE_METHODS,
    preferredMethod: null,
  };
}

export const giteaForgeLogic = {
  id: "gitea",
  urlGrammar: GITEA_FAMILY_URL_GRAMMAR,
  facts: defineForgeFacts({
    family: "gitea",
    schema: GiteaMergeFactsSchema,
    deriveMergeCapability: deriveGiteaMergeCapability,
    nativeFallbackChecks: [
      defineNativeFallbackCheck(GiteaMergeFactsSchema, {
        contribute: (facts, status, forge) => {
          if (!facts.ciStatus) {
            return null;
          }
          return {
            provider: forge,
            name: "CI",
            status: mapGiteaCommitState(facts.ciStatus),
            ...(facts.ciStatus === "warning" ? { traits: [CHECK_TRAIT_WARNING] } : {}),
            url: status.url,
          };
        },
      }),
    ],
  }),
} satisfies ClientForgeLogicModule<GiteaMergeFacts>;
