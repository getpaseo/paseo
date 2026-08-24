import { z } from "zod";
import {
  defineForgeFacts,
  defineNativeFallbackCheck,
  GITEA_FAMILY_URL_GRAMMAR,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { mapCheckStatus, type CheckStatus } from "@/git/pull-request-panel/check-status";

const GiteaMergeFactsSchema = z
  .object({
    forge: z.literal("gitea"),
    mergeable: z.boolean().optional().default(false),
    hasMerged: z.boolean().optional().default(false),
    ciStatus: z.string().nullable().optional().default(null),
  })
  .passthrough();

type GiteaMergeFacts = z.infer<typeof GiteaMergeFactsSchema>;

// forgeSpecific.ciStatus carries Gitea's raw aggregate CI string. Server twin:
// packages/server/src/services/gitea-service.ts (mapGiteaCommitStatus) — "warning"
// and "error" are terminal, non-passing states, but the generic mapCheckStatus
// would show them as pending, so interpret them here where the module owns Gitea
// facts.
function mapGiteaCiStatus(ciStatus: string): CheckStatus {
  if (ciStatus === "warning" || ciStatus === "error") {
    return "failure";
  }
  return mapCheckStatus(ciStatus);
}

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
            status: mapGiteaCiStatus(facts.ciStatus),
            url: status.url,
          };
        },
      }),
    ],
  }),
} satisfies ClientForgeLogicModule<GiteaMergeFacts>;
