import { z } from "zod";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { ensureValidJson } from "../json-utils.js";
import {
  isTypeSafeAuthError,
  TypeSafeSystemOneClient,
  type TypeSafeDecisionRequest,
  type TypeSafeDecisionSource,
} from "../browser-tools/jev-client.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import { SYSTEM_ONE_CALL_EXAMPLE } from "../agent/writing-block-instruction.js";
import { SystemOneCredentialStore } from "./credential-store.js";
import { isSystemOneExcluded, SYSTEM_ONE_EXCLUDED_MESSAGE } from "./scope.js";
import { recordSystemOneUsage, type SystemOneUsagePurpose } from "./usage-log.js";

const StructuredValueSchema = z.json();
const SENSITIVE_FIELD_PATTERN =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|secret)$/i;
const ChoiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    // TypeSafe answers choice questions from criteria alone.
    instructions: StructuredValueSchema.optional(),
    criteria: z.record(z.string().min(1), StructuredValueSchema),
  })
  .strict()
  .refine((question) => Object.keys(question.criteria).length >= 2, {
    message: "Choice questions need at least two criteria",
  });
const ScoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: StructuredValueSchema,
    criteria: z.array(StructuredValueSchema).min(2).max(20),
  })
  .strict();
const NoulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: StructuredValueSchema,
    criteria: StructuredValueSchema.optional(),
  })
  .strict();
const SystemOneInputSchema = z
  .object({
    state: StructuredValueSchema,
    questions: z.record(
      z.string().min(1),
      z.discriminatedUnion("type", [ChoiceQuestionSchema, ScoreQuestionSchema, NoulQuestionSchema]),
    ),
  })
  .strict()
  .superRefine((input, context) => {
    const questionCount = Object.keys(input.questions).length;
    if (questionCount < 1 || questionCount > 32) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Send between 1 and 32 independent questions in one request",
      });
    }
    if (JSON.stringify(input).length > 64_000) {
      context.addIssue({
        code: "custom",
        message: "System One input exceeds PandaOS's 64 KB decision-state limit",
      });
    }
    const sensitivePath = findSensitiveFieldPath(input);
    if (sensitivePath) {
      context.addIssue({
        code: "custom",
        path: sensitivePath,
        message: "Remove secrets before sending state or questions to System One",
      });
    }
  });

function findSensitiveFieldPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const match = findSensitiveFieldPath(entry, [...path, index]);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) return [...path, key];
    const match = findSensitiveFieldPath(entry, [...path, key]);
    if (match) return match;
  }
  return null;
}

interface RegisterSystemOneToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      input: z.infer<typeof SystemOneInputSchema>,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  paseoHome: string;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  resolveCwd?: () => string | undefined;
}

export const BROWSER_GOALS_OFF_MESSAGE =
  "Jev browser goals are turned off in PandaOS Settings → System One. Drive the browser_* tools step by step instead, and do not call browser_goal again this session.";

export function createConfiguredSystemOneDecisionSource(
  paseoHome: string,
  daemonConfigStore: Pick<DaemonConfigStore, "get">,
  resolveCwd: () => string | undefined = () => undefined,
  purpose: SystemOneUsagePurpose = "tool",
): TypeSafeDecisionSource {
  return {
    async decide(request) {
      if (isSystemOneExcluded(paseoHome, resolveCwd())) {
        throw new Error(SYSTEM_ONE_EXCLUDED_MESSAGE);
      }
      const config = daemonConfigStore.get().systemOne;
      if (!config) {
        throw new Error("System One is unavailable on this host. Update the PandaOS daemon.");
      }
      if (!config.enabled) {
        throw new Error("System One is disabled. Enable it in Paseo Settings → System One.");
      }
      if (purpose === "browser" && config.browserGoals === false) {
        throw new Error(BROWSER_GOALS_OFF_MESSAGE);
      }
      const credentials = new SystemOneCredentialStore(paseoHome).candidates();
      if (credentials.length === 0) {
        throw new Error("TypeSafe API key is not configured in Paseo Settings → System One.");
      }
      const rejected: string[] = [];
      for (const credential of credentials) {
        try {
          const decision = await new TypeSafeSystemOneClient({
            apiKey: credential.apiKey,
            model: config.model,
            endpoint: config.endpoint,
          }).decide(request);
          // Usage stats must never fail or slow a decision.
          void recordSystemOneUsage(paseoHome, purpose, decision.usage).catch(() => {});
          return decision;
        } catch (error) {
          // A stale saved key must not hide a working key from the environment or env file.
          if (!isTypeSafeAuthError(error)) throw error;
          rejected.push(credential.source);
        }
      }
      throw new Error(
        `TypeSafe rejected every configured API key (${rejected.join(", ")}). Save a valid key in Paseo Settings → System One.`,
      );
    },
  };
}

/** Returns false only when TypeSafe explicitly rejects the key; network trouble is not a verdict. */
export async function isTypeSafeApiKeyAccepted(
  apiKey: string,
  model: string,
  endpoint?: string,
): Promise<boolean> {
  try {
    await new TypeSafeSystemOneClient({ apiKey, model, endpoint, timeoutMs: 10_000 }).decide({
      state: { check: "paseo-key-validation" },
      questions: {
        valid: { type: "choice", criteria: { yes: "This is a key check", no: "Anything else" } },
      },
    });
    return true;
  } catch (error) {
    return !isTypeSafeAuthError(error);
  }
}

export function registerSystemOneTools(options: RegisterSystemOneToolsOptions): void {
  options.registerTool(
    "system_one_decide",
    {
      title: "Make fast structured decisions with Jev",
      description: `Ask Jev one or more independent Choice, Score, or Noul questions over shared structured state. Both state and questions are required. questions must be a nonempty object keyed by question name, for example ${SYSTEM_ONE_CALL_EXAMPLE}. Batch every currently useful question into one call. Use this for fast routing, classification, relevance, risk, confidence, or selecting among a closed set; keep deterministic facts and multi-step reasoning in code. Never include API keys, tokens, passwords, private keys, or other secrets in state or questions.`,
      inputSchema: SystemOneInputSchema,
    },
    async (input) => {
      const config = options.daemonConfigStore.get().systemOne;
      if (!config) {
        throw new Error("System One is unavailable on this host. Update the Paseo daemon.");
      }
      const result = await createConfiguredSystemOneDecisionSource(
        options.paseoHome,
        options.daemonConfigStore,
        options.resolveCwd,
      ).decide(input as TypeSafeDecisionRequest);
      const structuredContent = ensureValidJson({
        ...result,
        minimumConfidence: config.minimumConfidence,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}
