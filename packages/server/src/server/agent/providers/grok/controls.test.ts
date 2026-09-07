import { expect, test } from "vitest";
import pino from "pino";
import { GrokACPAgentClient } from "./agent.js";
import {
  readGrokModels,
  transformGrokSessionResponse,
  writeGrokThinkingOption,
  writeGrokModel,
  writeGrokPermissionMode,
  GROK_REASONING_CONFIG_ID,
  GrokSelectionError,
  GROK_MODES,
} from "./controls.js";
import { FakeGrokConnection } from "./fake-connection.js";

// Reduced from Grok 1.0.13's session/new response.
const modelState = {
  currentModelId: "grok-4.6",
  availableModels: [
    {
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "xhigh", label: "Extra High", default: false },
          { id: "high", label: "High Effort", default: true },
          { id: "low", label: "Low Effort", default: false },
        ],
      },
    },
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", label: "High Effort", default: true },
          { id: "low", label: "Low Effort", default: false },
        ],
      },
    },
  ],
};

test("discovers each Grok model's effort choices without standard ACP config options", () => {
  const models = readGrokModels({ provider: "grok", modelState, configOptions: [] });
  expect(
    models.map((model) => ({
      id: model.id,
      efforts: model.thinkingOptions?.map((option) => option.id),
      defaultEffort: model.defaultThinkingOptionId,
    })),
  ).toEqual([
    { id: "grok-4.6", efforts: ["xhigh", "high", "low"], defaultEffort: "high" },
    { id: "grok-4.5", efforts: ["high", "low"], defaultEffort: "high" },
  ]);
  expect(models[0]?.thinkingOptions?.map((option) => option.label)).toEqual([
    "Extra High",
    "High",
    "Low",
  ]);
});

test("rejects unsupported Grok launch commands with the configured argv", () => {
  const command: [string, ...string[]] = ["/path/to/grok-wrapper"];
  expect(
    () =>
      new GrokACPAgentClient({
        providerId: "grok",
        logger: pino({ level: "silent" }),
        command,
      }),
  ).toThrow(expect.objectContaining({ name: "GrokLaunchError", command }));
});

test("keeps native permission policy when the registry stores client callbacks", () => {
  const client = new GrokACPAgentClient({
    logger: pino({ level: "silent" }),
    command: ["grok", "agent", "stdio"],
    providerId: "grok",
  });
  const { resolveCreateConfig, isCreateConfigUnattended } = client;
  expect(
    resolveCreateConfig({
      provider: "grok",
      requestedMode: undefined,
      featureValues: undefined,
      parent: null,
      unattended: true,
      availableModes: GROK_MODES,
    }),
  ).toEqual({ modeId: "always-approve", featureValues: undefined });
  expect(
    isCreateConfigUnattended({
      modeId: "ask",
      availableModes: GROK_MODES,
      config: { provider: "grok", cwd: "/tmp", featureValues: { auto_accept: true } },
    }),
  ).toBe(false);
});

test("does not copy the current model's efforts onto a model without reasoning support", () => {
  const noThinkingModel = {
    modelId: "no-thinking",
    name: "No thinking",
    _meta: { supportsReasoningEffort: false },
  };
  const response = transformGrokSessionResponse({ sessionId: "test", models: modelState });
  const models = readGrokModels({
    provider: "grok",
    modelState: {
      ...modelState,
      availableModels: [...modelState.availableModels, noThinkingModel],
    },
    configOptions: response.configOptions ?? [],
  });
  expect(models[2]?.thinkingOptions).toEqual([]);
  expect(models[2]?.defaultThinkingOptionId).toBeUndefined();
});

test("applies an advertised effort and preserves it on a compatible model switch", async () => {
  const connection = new FakeGrokConnection();
  const response = transformGrokSessionResponse({ sessionId: "test", models: modelState });
  const configOptions = response.configOptions ?? [];
  await writeGrokThinkingOption({
    connection,
    sessionId: "test",
    requestedThinkingOptionId: "low",
    availableModel: modelState.availableModels[0]!,
    configOptions,
  });
  expect(connection.effort).toBe("low");
  const result = await writeGrokModel({
    connection,
    sessionId: "test",
    availableModel: modelState.availableModels[1]!,
    currentThinkingOptionId: "low",
    configOptions,
  });
  expect(connection.model).toBe("grok-4.5");
  expect(connection.effort).toBe("low");
  expect(result).toMatchObject({
    currentModelId: "grok-4.5",
    thinkingOptionId: "low",
  });
});

test("uses the target model default when the old effort is unsupported and updates its choices", async () => {
  const connection = new FakeGrokConnection();
  const response = transformGrokSessionResponse({ sessionId: "test", models: modelState });
  const result = await writeGrokModel({
    connection,
    sessionId: "test",
    availableModel: modelState.availableModels[1]!,
    currentThinkingOptionId: "xhigh",
    configOptions: response.configOptions ?? [],
  });
  expect(result).toEqual({
    currentModelId: "grok-4.5",
    thinkingOptionId: "high",
    configOptions: [
      {
        id: GROK_REASONING_CONFIG_ID,
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "high", name: "High", description: undefined },
          { value: "low", name: "Low", description: undefined },
        ],
      },
    ],
  });
  expect(connection.effort).toBe("high");
  await expect(
    writeGrokThinkingOption({
      connection,
      sessionId: "test",
      requestedThinkingOptionId: "xhigh",
      availableModel: modelState.availableModels[1]!,
      configOptions: result.configOptions,
    }),
  ).rejects.toThrow(GrokSelectionError);
});

test("clears effort by restoring the advertised default, not the current selection", async () => {
  const connection = new FakeGrokConnection();
  const availableModel = {
    ...modelState.availableModels[0]!,
    _meta: { ...modelState.availableModels[0]!._meta, reasoningEffort: "low" },
  };
  const response = transformGrokSessionResponse({
    models: { ...modelState, availableModels: [availableModel] },
  });
  connection.effort = "low";
  expect(
    await writeGrokThinkingOption({
      connection,
      sessionId: "test",
      requestedThinkingOptionId: null,
      availableModel,
      configOptions: response.configOptions ?? [],
    }),
  ).toMatchObject({ thinkingOptionId: null });
  expect(connection.effort).toBe("high");
});

test("switches native permissions without leaving another approval mode active", async () => {
  const connection = new FakeGrokConnection();
  await writeGrokPermissionMode({ connection, modeId: "always-approve" });
  expect([connection.yolo, connection.auto]).toEqual([true, false]);
  await writeGrokPermissionMode({ connection, modeId: "auto" });
  expect([connection.yolo, connection.auto]).toEqual([false, true]);
  await writeGrokPermissionMode({ connection, modeId: "ask" });
  expect([connection.yolo, connection.auto]).toEqual([false, false]);
  await expect(writeGrokPermissionMode({ connection, modeId: "plan" })).rejects.toThrow(
    GrokSelectionError,
  );
  expect([connection.yolo, connection.auto]).toEqual([false, false]);
});

test("surfaces failed effort, model, and permission writes without reporting a new selection", async () => {
  const connection = new FakeGrokConnection();
  const failure = new Error("ACP disconnected");
  connection.failure = failure;
  const response = transformGrokSessionResponse({ sessionId: "test", models: modelState });
  const configOptions = response.configOptions ?? [];
  await expect(
    writeGrokThinkingOption({
      connection,
      sessionId: "test",
      requestedThinkingOptionId: "low",
      availableModel: modelState.availableModels[0]!,
      configOptions,
    }),
  ).rejects.toBe(failure);
  await expect(
    writeGrokModel({
      connection,
      sessionId: "test",
      availableModel: modelState.availableModels[1]!,
      currentThinkingOptionId: "low",
      configOptions,
    }),
  ).rejects.toBe(failure);
  await expect(writeGrokPermissionMode({ connection, modeId: "always-approve" })).rejects.toBe(
    failure,
  );
  expect([connection.model, connection.effort, connection.yolo, connection.auto]).toEqual([
    "grok-4.6",
    "high",
    false,
    false,
  ]);
});

test("rejects metadata whose selected effort is not offered by the model", () => {
  const inconsistent = structuredClone(modelState);
  for (const model of inconsistent.availableModels) {
    model._meta.reasoningEffort = "unsupported";
  }
  expect(() =>
    readGrokModels({ provider: "grok", modelState: inconsistent, configOptions: [] }),
  ).toThrow("not in the advertised effort choices");
});
