import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { ZodError } from "zod";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { deriveModelDefinitionsFromACP, type ACPCatalogModelResolverContext } from "./acp-agent.js";
import { resolveCursorCatalogModels } from "./cursor-acp-agent.js";

const modelOption: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "claude-haiku-4-5",
  options: [
    { value: "claude-haiku-4-5", name: "Haiku 4.5" },
    { value: "grok-4.6", name: "Grok 4.6" },
  ],
};

const booleanThinking: SessionConfigOption = {
  id: "thinking",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "true",
  options: [
    { value: "false", name: "Off" },
    { value: "true", name: "On" },
  ],
};

const effortThinking: SessionConfigOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "xhigh",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
    { value: "xhigh", name: "Extra High" },
  ],
};

class CursorCatalogConnection {
  selectedModel = "claude-haiku-4-5";
  selectionHistory = ["claude-haiku-4-5"];
  error: unknown = null;
  catalog: Record<string, unknown> = {
    models: [
      { value: "claude-haiku-4-5", name: "Haiku 4.5", configOptions: [booleanThinking] },
      { value: "grok-4.6", name: "Grok 4.6", configOptions: [effortThinking] },
    ],
  };

  async extMethod(method: string, params: Record<string, unknown>) {
    if (method !== "cursor/list_available_models" || Object.keys(params).length !== 0) {
      throw new Error(`Unsupported catalog request: ${method}`);
    }
    if (this.error) throw this.error;
    return this.catalog;
  }

  async setSessionConfigOption({ value }: { value: string }) {
    this.selectedModel = value;
    this.selectionHistory.push(value);
    const thinking = value === "grok-4.6" ? effortThinking : booleanThinking;
    return { configOptions: [thinking] };
  }
}

function createCatalogContext(
  connection: CursorCatalogConnection,
  configOptions: SessionConfigOption[] = [modelOption, booleanThinking],
): ACPCatalogModelResolverContext {
  return {
    connection,
    sessionId: "catalog-session",
    models: deriveModelDefinitionsFromACP("acp", null, configOptions),
    configOptions,
    runRequest: (request) => request(),
    transformConfigOptions: (options) => options,
    logger: createTestLogger(),
    provider: "acp",
  };
}

test("lists each model's thinking options without changing Cursor preferences", async () => {
  const connection = new CursorCatalogConnection();
  const context = createCatalogContext(connection);

  const models = await resolveCursorCatalogModels(context);

  expect(connection.selectedModel).toBe("claude-haiku-4-5");
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
  expect(
    models.map(({ id, isDefault, thinkingOptions, defaultThinkingOptionId }) => ({
      id,
      isDefault,
      thinking: thinkingOptions?.map((option) => option.id),
      defaultThinkingOptionId,
    })),
  ).toEqual([
    {
      id: "claude-haiku-4-5",
      isDefault: true,
      thinking: ["false", "true"],
      defaultThinkingOptionId: "true",
    },
    {
      id: "grok-4.6",
      isDefault: false,
      thinking: ["low", "medium", "high", "xhigh"],
      defaultThinkingOptionId: "xhigh",
    },
  ]);
});

test("reports that Cursor must be updated when the model extension is unavailable", async () => {
  const connection = new CursorCatalogConnection();
  connection.error = { code: -32601, message: "Method not found" };

  await expect(resolveCursorCatalogModels(createCatalogContext(connection))).rejects.toThrow(
    "Update Cursor CLI",
  );
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
});

test("discovers thinking models when the session default has no thinking selector", async () => {
  const connection = new CursorCatalogConnection();
  const context = createCatalogContext(connection, [modelOption]);

  const models = await resolveCursorCatalogModels(context);

  expect(models[1].thinkingOptions?.map((option) => option.id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
});

test("uses the extension's complete catalog even when session/new lists only one model", async () => {
  const connection = new CursorCatalogConnection();
  const context = createCatalogContext(connection);
  context.models = context.models.slice(0, 1);

  const models = await resolveCursorCatalogModels(context);

  expect(models.map((model) => model.id)).toEqual(["claude-haiku-4-5", "grok-4.6"]);
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
});

test("does not copy session thinking options onto a model without a selector", async () => {
  const connection = new CursorCatalogConnection();
  connection.catalog = {
    models: [{ value: "composer-2", name: "Composer", configOptions: [] }],
  };

  const models = await resolveCursorCatalogModels(createCatalogContext(connection));

  expect(models).toEqual([
    {
      provider: "acp",
      id: "composer-2",
      label: "Composer",
      isDefault: false,
      thinkingOptions: undefined,
      defaultThinkingOptionId: undefined,
    },
  ]);
});

test("keeps an empty extension catalog empty", async () => {
  const connection = new CursorCatalogConnection();
  connection.catalog = { models: [] };

  await expect(resolveCursorCatalogModels(createCatalogContext(connection))).resolves.toEqual([]);
});

test.each([
  {},
  { models: [{ value: "grok-4.6", name: "Grok 4.6" }] },
  {
    models: [
      {
        value: "grok-4.6",
        name: "Grok 4.6",
        configOptions: [{ ...effortThinking, currentValue: 1 }],
      },
    ],
  },
])("rejects malformed extension responses: %j", async (catalog) => {
  const connection = new CursorCatalogConnection();
  connection.catalog = catalog;

  await expect(resolveCursorCatalogModels(createCatalogContext(connection))).rejects.toBeInstanceOf(
    ZodError,
  );
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
});

test("propagates extension failures without changing preferences or returning stale options", async () => {
  const connection = new CursorCatalogConnection();
  const error = new Error("Connection closed");
  connection.error = error;

  await expect(resolveCursorCatalogModels(createCatalogContext(connection))).rejects.toBe(error);
  expect(connection.selectionHistory).toEqual(["claude-haiku-4-5"]);
});
