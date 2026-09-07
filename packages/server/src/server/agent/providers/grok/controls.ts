import type { SessionConfigOption, SessionModelState } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AgentMode, AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";
import {
  deriveModelDefinitionsFromACP,
  type SessionStateResponse,
  type ACPProviderModelWriterContext,
  type ACPProviderModelWriteResult,
  type ACPProviderThinkingOptionWriterContext,
  type ACPProviderThinkingOptionWriteResult,
  type ACPNativePermissionWriterContext,
} from "../acp-agent.js";

interface GrokCatalogInput {
  provider: string;
  modelState: SessionModelState | null | undefined;
  configOptions: SessionConfigOption[];
}

const ModelMetadata = z.object({
  supportsReasoningEffort: z.boolean().optional(),
  reasoningEffort: z.string().optional(),
  reasoningEfforts: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
        default: z.boolean(),
      }),
    )
    .optional(),
});

interface ModelThinking {
  options: AgentSelectOption[];
  currentId: string | null;
}

function readModelThinking(metadata: unknown): ModelThinking {
  const parsed = ModelMetadata.parse(metadata ?? {});
  if (parsed.supportsReasoningEffort === false || !parsed.reasoningEfforts?.length) {
    return { options: [], currentId: null };
  }
  const currentId =
    parsed.reasoningEffort ?? parsed.reasoningEfforts.find((effort) => effort.default)?.id ?? null;
  if (!currentId || !parsed.reasoningEfforts.some((effort) => effort.id === currentId)) {
    // Do not advertise a selection that Grok's own metadata says is unsupported.
    throw new GrokMetadataError(currentId);
  }
  return {
    currentId,
    options: parsed.reasoningEfforts.map((effort) => ({
      id: effort.id,
      label: effort.label.trim().replace(/\s+effort$/i, ""),
      description: effort.description,
      isDefault: effort.id === currentId,
    })),
  };
}

export function readGrokModels({
  provider,
  modelState,
  configOptions,
}: GrokCatalogInput): AgentModelDefinition[] {
  if (!modelState) {
    return deriveModelDefinitionsFromACP(provider, modelState, configOptions);
  }
  return modelState.availableModels.map((model) => {
    const thinking = readModelThinking(model._meta);
    return {
      provider,
      id: model.modelId,
      label: model.name,
      description: model.description ?? undefined,
      isDefault: model.modelId === modelState.currentModelId,
      thinkingOptions: thinking.options,
      defaultThinkingOptionId: thinking.currentId ?? undefined,
    };
  });
}

export const GROK_REASONING_CONFIG_ID = "_paseo.grok.reasoning_effort";

function thinkingConfig({ options, currentId }: ModelThinking): SessionConfigOption[] {
  if (!currentId) return [];
  return [
    {
      id: GROK_REASONING_CONFIG_ID,
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: currentId,
      options: options.map((option) => ({
        value: option.id,
        name: option.label,
        description: option.description,
      })),
    },
  ];
}

export function transformGrokSessionResponse(response: SessionStateResponse): SessionStateResponse {
  const configOptions = response.configOptions ?? [];
  const currentModel = response.models?.availableModels.find(
    (model) => model.modelId === response.models?.currentModelId,
  );
  const thinking = readModelThinking(currentModel?._meta);
  return {
    ...response,
    configOptions: [...configOptions, ...thinkingConfig(thinking)],
  };
}

export async function writeGrokThinkingOption({
  connection,
  sessionId,
  requestedThinkingOptionId,
  availableModel,
  configOptions,
}: ACPProviderThinkingOptionWriterContext): Promise<ACPProviderThinkingOptionWriteResult> {
  const { options } = readModelThinking(availableModel?._meta);
  if (requestedThinkingOptionId === null && options.length === 0) {
    return { thinkingOptionId: null, configOptions };
  }
  const thinkingOptionId =
    requestedThinkingOptionId ??
    ModelMetadata.parse(availableModel?._meta ?? {}).reasoningEfforts?.find(
      (effort) => effort.default,
    )?.id;
  if (!thinkingOptionId || !options.some((entry) => entry.id === thinkingOptionId)) {
    throw new GrokSelectionError({ control: "effort", value: thinkingOptionId ?? "default" });
  }
  // Grok 1.0.13 uses session/set_mode for effort, independently of permission mode.
  await connection.setSessionMode({ sessionId, modeId: thinkingOptionId });
  return {
    thinkingOptionId: requestedThinkingOptionId,
    configOptions: [
      ...configOptions.filter((option) => option.id !== GROK_REASONING_CONFIG_ID),
      ...thinkingConfig({ options, currentId: thinkingOptionId }),
    ],
  };
}

export async function writeGrokModel({
  connection,
  sessionId,
  availableModel,
  currentThinkingOptionId,
  configOptions,
}: ACPProviderModelWriterContext): Promise<ACPProviderModelWriteResult> {
  const thinking = readModelThinking(availableModel._meta);
  const supportsCurrentEffort = thinking.options.some(
    (option) => option.id === currentThinkingOptionId,
  );
  const thinkingOptionId = supportsCurrentEffort ? currentThinkingOptionId : thinking.currentId;
  const response = await connection.unstable_setSessionModel({
    sessionId,
    modelId: availableModel.modelId,
    _meta: { reasoningEffort: thinkingOptionId },
  });
  const modelResult = GrokModelResponse.parse(response);
  if (modelResult._meta?.model && "Err" in modelResult._meta.model) {
    throw new GrokSelectionError({ control: "model", value: availableModel.modelId });
  }
  const retainedOptions = configOptions.filter((option) => option.id !== GROK_REASONING_CONFIG_ID);
  return {
    currentModelId: availableModel.modelId,
    thinkingOptionId,
    configOptions: [
      ...retainedOptions,
      ...thinkingConfig({ options: thinking.options, currentId: thinkingOptionId }),
    ],
  };
}

const GrokModelResponse = z.object({
  _meta: z
    .object({
      model: z.union([z.object({ Ok: z.string() }), z.object({ Err: z.unknown() })]).optional(),
    })
    .optional(),
});

interface GrokSelectionFailure {
  control: "model" | "effort" | "permission";
  value: string;
}

export class GrokSelectionError extends Error {
  readonly control: GrokSelectionFailure["control"];
  readonly value: string;
  constructor({ control, value }: GrokSelectionFailure) {
    super(`Grok cannot select ${control} '${value}'`);
    this.name = "GrokSelectionError";
    this.control = control;
    this.value = value;
  }
}

const PermissionMode = z.enum(["ask", "auto", "always-approve"]);

export const GROK_MODES: AgentMode[] = [
  { id: "ask", label: "Ask", description: "Ask before tools that are not already allowed." },
  { id: "auto", label: "Auto", description: "Grok approves safe tools and asks about others." },
  {
    id: "always-approve",
    label: "Always Approve",
    description: "Approve tools automatically, subject to Grok's deny rules and hooks.",
    isUnattended: true,
  },
];

export async function writeGrokPermissionMode({
  connection,
  modeId,
}: ACPNativePermissionWriterContext): Promise<void> {
  const parsed = PermissionMode.safeParse(modeId);
  if (!parsed.success) throw new GrokSelectionError({ control: "permission", value: modeId });
  // This notification targets resident sessions in the process. Grok must use
  // --no-leader so changing one Paseo agent cannot change another agent's permissions.
  // The JS ACP SDK sends extension names verbatim; Grok requires the wire prefix.
  await connection.extNotification("_x.ai/yolo_mode_changed", {
    permission_mode: parsed.data,
    yolo_mode: parsed.data === "always-approve",
    auto_mode: parsed.data === "auto",
  });
}

class GrokMetadataError extends Error {
  constructor(readonly effort: string | null) {
    super(`Grok's selected effort '${effort}' is not in the advertised effort choices`);
    this.name = "GrokMetadataError";
  }
}
