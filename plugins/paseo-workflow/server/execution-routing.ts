import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { executionDecision } from "../shared/rpc";
export { executionDecision } from "../shared/rpc";

export const routes = [
  { category: "trivial", model: "gpt-5.6-luna", effort: "low" },
  { category: "bounded", model: "gpt-5.6-sol", effort: "medium" },
  { category: "diagnostic", model: "gpt-5.6-sol", effort: "high" },
  { category: "complex", model: "gpt-6-astra", effort: "high" },
  { category: "critical", model: "gpt-6-astra", effort: "xhigh" },
] as const;

export type ExecutionCategory = (typeof routes)[number]["category"];
export type ExecutionDecision = z.infer<typeof executionDecision>;

export interface InitialExecutionRoutingInput {
  prompt: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
  workspaceIntent?: string;
}

const categories = routes.map((route) => route.category);
const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.enum(categories),
  probabilities: z.record(z.enum(categories), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
});
const responseSchema = z.object({
  model: z.literal("jev-1.13.0"),
  answers: z.object({ execution: answerSchema }),
});

function keyFromText(text: string): string | undefined {
  const values = parseEnv(text);
  return values.TYPESAFE_API_KEY?.trim() || values["JEV-API-KEY"]?.trim() || undefined;
}

async function apiKey(env: NodeJS.ProcessEnv) {
  const direct = env.TYPESAFE_API_KEY?.trim() || env["JEV-API-KEY"]?.trim();
  if (direct) return direct;
  const configuredHome = env.PASEO_HOME?.trim();
  const home = configuredHome?.startsWith("~")
    ? path.join(os.homedir(), configuredHome.slice(1))
    : path.resolve(configuredHome || path.join(os.homedir(), ".paseo"));
  try {
    return keyFromText(await readFile(path.join(home, "paseo-workflow.env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const criteria = {
  trivial: "Documentation, copy, formatting, or one isolated mechanical edit.",
  bounded: "A bounded implementation with known local impact.",
  diagnostic: "Diagnosis, uncertainty, or several interacting local causes.",
  complex: "Broad, cross-package, or architecture-affecting work.",
  critical: "Authentication, security, migration, destructive action, or user data.",
};

export async function classifyExecution(
  briefing: string,
  signal?: AbortSignal,
  dependencies: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
  options: { minConfidence?: number } = {},
): Promise<ExecutionDecision> {
  const key = await apiKey(dependencies.env ?? process.env);
  if (!key)
    throw new Error(
      "La clé JEV est absente. Ajoutez TYPESAFE_API_KEY ou JEV-API-KEY à paseo-workflow.env.",
    );
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) throw new Error("La classification JEV a été annulée.");
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  const minConfidence = options.minConfidence ?? 0.5;
  try {
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "jev-1.13.0",
          state: briefing,
          questions: {
            execution: {
              type: "choice",
              instructions:
                "Choisis la catégorie d'exécution du plan. Le risque et l'incertitude augmentent la catégorie, jamais l'inverse.",
              criteria,
            },
          },
        }),
      });
    } catch (error) {
      if (timedOut) throw new Error("JEV a dépassé le délai de 15 secondes.", { cause: error });
      if (controller.signal.aborted)
        throw new Error("La classification JEV a été annulée.", { cause: error });
      throw new Error("La classification JEV a échoué à cause d'une erreur réseau.", {
        cause: error,
      });
    }
    if (!response.ok) throw new Error(`JEV a refusé la classification (HTTP ${response.status}).`);
    let answer: z.infer<typeof answerSchema>;
    try {
      answer = responseSchema.parse(await response.json()).answers.execution;
    } catch {
      throw new Error("JEV a retourné une réponse de classification invalide.");
    }
    if (
      Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) >
      0.001
    )
      throw new Error("JEV a retourné une distribution de classification incohérente.");
    if (answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities)))
      throw new Error("JEV a retourné un choix incohérent avec sa distribution de classification.");
    if (answer.confidence < minConfidence)
      throw new Error(`JEV est insuffisamment confiant (${answer.confidence.toFixed(2)}).`);
    const route = routes.find((entry) => entry.category === answer.choice)!;
    return {
      ...route,
      provider: "codex",
      reason: `JEV jev-1.13.0: ${answer.choice} (${answer.confidence.toFixed(2)})`,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function classifyInitialExecution(
  input: InitialExecutionRoutingInput,
  signal?: AbortSignal,
  dependencies?: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch },
): Promise<ExecutionDecision> {
  const planToggle = input.featureValues?.plan_mode;
  const planMode =
    typeof planToggle === "boolean"
      ? planToggle
      : input.modeId === "plan" || input.modeId?.endsWith("#plan") === true;
  return classifyExecution(
    [
      "Initial user request:",
      input.prompt,
      input.workspaceIntent ? `Workspace intention:\n${input.workspaceIntent}` : undefined,
      planMode
        ? "The user selected Plan mode. Classify the difficulty of designing the plan, not implementing it."
        : "The user selected Execute mode. Classify the difficulty of implementing the request.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    signal,
    dependencies,
    { minConfidence: 0 },
  );
}
