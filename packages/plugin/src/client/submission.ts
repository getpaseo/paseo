import type { PaseoAgentConfig, PaseoAgentSendOptions } from "@getpaseo/client";

export interface PluginSubmissionCheckInput {
  cwd: string;
  projectId?: string;
  projectName?: string;
  projectRootPath?: string;
  executionId: string;
  presetId?: string;
  text: string;
  images: NonNullable<PaseoAgentSendOptions["images"]>;
  attachments: NonNullable<PaseoAgentSendOptions["attachments"]>;
  idempotencyKey: string;
  defaultAgentConfig?: PaseoAgentConfig;
  routingMode: "auto" | "manual";
}

export interface PluginSubmissionDecision {
  title: string;
  description?: string;
  choices: readonly { id: string; title: string; description?: string }[];
  textInput?: { label: string; initialValue?: string; placeholder?: string };
  timeout?: { seconds: number; choiceId: string };
}

export interface PluginSubmissionChoice {
  choiceId: string;
  textValue?: string;
  automatic: boolean;
}

export interface PluginSubmissionTarget {
  cwd: string;
  projectId?: string;
  isolation?: "local" | "worktree";
}

export interface PluginSubmissionCheckContribution {
  id: string;
  check(
    input: PluginSubmissionCheckInput,
    context: { signal: AbortSignal },
  ): Promise<PluginSubmissionDecision | void>;
  resolve(
    input: PluginSubmissionCheckInput,
    choice: PluginSubmissionChoice,
    context: { signal: AbortSignal },
  ): Promise<PluginSubmissionTarget | void>;
}
