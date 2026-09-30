import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isSafeSystemOneEndpoint } from "@getpaseo/protocol/messages";

export const DEFAULT_TYPESAFE_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TYPESAFE_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TypeSafeChoiceQuestion {
  type: "choice";
  criteria: Record<string, unknown>;
  instructions?: unknown;
}

export interface TypeSafeScoreQuestion {
  type: "score";
  criteria: unknown[];
  instructions: unknown;
}

export interface TypeSafeNoulQuestion {
  type: "noul";
  instructions: unknown;
  criteria?: unknown;
}

export type TypeSafeQuestion =
  | TypeSafeChoiceQuestion
  | TypeSafeScoreQuestion
  | TypeSafeNoulQuestion;

export interface TypeSafeChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TypeSafeDecisionRequest {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
}

export interface TypeSafeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TypeSafeDecisionResponse {
  answers: Record<string, unknown>;
  model: string;
  latencyMs: number;
  usage?: TypeSafeUsage;
}

export interface TypeSafeDecisionSource {
  decide(request: TypeSafeDecisionRequest): Promise<TypeSafeDecisionResponse>;
}

interface TypeSafeSystemOneClientOptions {
  apiKey?: string;
  envFile?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TypeSafeHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`TypeSafe returned HTTP ${status}; no browser action executed.`);
    this.name = "TypeSafeHttpError";
    this.status = status;
  }
}

export function isTypeSafeAuthError(error: unknown): boolean {
  return error instanceof TypeSafeHttpError && (error.status === 401 || error.status === 403);
}

export class TypeSafeSystemOneClient implements TypeSafeDecisionSource {
  private readonly options: TypeSafeSystemOneClientOptions;

  public constructor(options: TypeSafeSystemOneClientOptions = {}) {
    if (options.endpoint !== undefined && !isSafeSystemOneEndpoint(options.endpoint)) {
      throw new Error("System One endpoint must use HTTP(S) without embedded credentials");
    }
    this.options = options;
  }

  public async decide(request: TypeSafeDecisionRequest): Promise<TypeSafeDecisionResponse> {
    const apiKey = this.options.apiKey ?? (await loadTypeSafeApiKey(this.options.envFile));
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const startedAt = performance.now();

    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        this.options.endpoint ?? DEFAULT_TYPESAFE_API_ENDPOINT,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model ?? process.env.TYPESAFE_MODEL ?? DEFAULT_TYPESAFE_MODEL,
            ...request,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new TypeSafeHttpError(response.status);
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.answers) || typeof payload.model !== "string") {
        throw new Error("TypeSafe returned an invalid response; no browser action executed.");
      }

      const usage = parseUsage(payload.usage);
      return {
        answers: payload.answers,
        model: payload.model,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("TypeSafe timed out; no browser action executed.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function loadTypeSafeApiKey(envFile?: string): Promise<string> {
  const fromEnvironment = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnvironment) {
    return fromEnvironment;
  }

  const filePath =
    envFile ?? process.env.TYPESAFE_ENV_FILE ?? resolve(homedir(), ".config/typesafe-ai/env");
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    throw new Error(
      "TypeSafe API key is unavailable. Set TYPESAFE_API_KEY or configure ~/.config/typesafe-ai/env.",
    );
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    const value = stripMatchingQuotes(match[1] ?? "").trim();
    if (value) {
      return value;
    }
  }

  throw new Error(
    "TypeSafe API key is unavailable. Set TYPESAFE_API_KEY or configure ~/.config/typesafe-ai/env.",
  );
}

export function parseChoiceAnswer(
  value: unknown,
  allowedChoices: readonly string[],
): TypeSafeChoiceAnswer {
  if (!isRecord(value) || !isRecord(value.probabilities)) {
    throw new Error("TypeSafe returned an invalid choice; no browser action executed.");
  }

  const choice = value.choice;
  const confidence = value.confidence;
  const probabilities = value.probabilities;
  const allowed = new Set(allowedChoices);
  const probabilityKeys = Object.keys(probabilities);
  const probabilityValues = Object.values(probabilities);
  const numericProbabilityValues = probabilityValues.filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
  );
  const validNumbers =
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1 &&
    probabilityValues.every(
      (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1,
    );
  const total = probabilityValues.reduce<number>(
    (sum, entry) => sum + (typeof entry === "number" ? entry : 0),
    0,
  );
  const selectedProbability = typeof choice === "string" ? probabilities[choice] : undefined;
  const maximumProbability =
    numericProbabilityValues.length > 0 ? Math.max(...numericProbabilityValues) : -1;

  if (
    typeof choice !== "string" ||
    !allowed.has(choice) ||
    probabilityKeys.length !== allowed.size ||
    probabilityKeys.some((key) => !allowed.has(key)) ||
    !validNumbers ||
    Math.abs(total - 1) >= 0.02 ||
    typeof selectedProbability !== "number" ||
    selectedProbability < maximumProbability - 1e-6
  ) {
    throw new Error("TypeSafe returned an invalid choice; no browser action executed.");
  }

  return { choice, confidence, probabilities: probabilities as Record<string, number> };
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): TypeSafeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = value;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return { inputTokens, outputTokens };
}
