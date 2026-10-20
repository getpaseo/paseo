import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { filterPickerAgentModels } from "../../agent-sdk-types.js";
import { validateAgentConfigurationAgainstProvider } from "../../agent-configuration-validator.js";
import { PiRpcAgentClient } from "./agent.js";
import { PiCliRuntime } from "./cli-runtime.js";
import { createPiCatalogBridge, readPiCatalogProvenance } from "./minimax-catalog.js";
import type { PiModel } from "./rpc-types.js";
import { FakePi } from "./test-utils/fake-pi.js";

type Handler = (args: string, context: unknown) => Promise<void>;
const dataModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

// Execute the shipped bridge source. Only the external SDK's getAgentDir export
// is substituted; Node file reads, capability probes and notification payloads run.
async function loadBridge(source: string, directory: string) {
  const sdk = dataModule(`export function getAgentDir() { return ${JSON.stringify(directory)}; }`);
  const module = await import(
    dataModule(source.replaceAll("@earendil-works/pi-coding-agent", sdk))
  );
  const commands = new Map<string, Handler>();
  module.default({
    registerCommand: (name: string, command: { handler: Handler }) =>
      commands.set(name, command.handler),
  });
  return commands;
}

const textModels = (provider = "minimax", prefix = ""): PiModel[] =>
  ["MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"].map((id) => ({
    provider,
    id: prefix ? prefix + id.toLowerCase() + (id.endsWith("Flash") ? ":free" : "") : id,
    name: id,
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  }));

describe("Pi MiniMax native catalog bridge", () => {
  test.each([
    "builtin",
    "same-id-extension",
    "native-provider",
    "file-override",
    "unsupported",
    "broken-config",
    "registry-error",
  ])("preserves registry and requests with %s provenance", async (scenario) => {
    const directory = mkdtempSync(join(process.cwd(), ".pi-catalog-test-"));
    const models = [
      ...textModels(),
      ...textModels("minimax-cn"),
      ...textModels("openrouter", "minimax/"),
      { provider: "custom", id: "MiniMax-M2.7", input: ["text"] },
      { provider: "minimax", id: "MiniMax-M3-image", input: ["image"] },
      { provider: "minimax", id: "MiniMax-M2.1", api: "pi-virtual", input: ["text"] },
      { provider: "openai", id: "gpt-other", input: ["text"] },
    ];
    const originalModels = structuredClone(models);
    const registered =
      scenario === "same-id-extension" || scenario === "native-provider" ? ["minimax"] : [];
    if (scenario === "file-override")
      writeFileSync(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              models: [models[0]],
              apiKey: "must-not-leave-runtime",
            },
          },
        }),
      );
    if (scenario === "broken-config") writeFileSync(join(directory, "models.json"), "invalid");
    const registry = {
      getRegisteredProviderIds: scenario === "unsupported" ? undefined : () => registered,
      getError: () => (scenario === "registry-error" ? "config failed" : undefined),
      getAll: () => models,
    };
    const frames: Array<Record<string, unknown>> = [];
    const notifications: string[] = [];
    const launches: string[][] = [];
    let selected: PiModel = models[0]!;
    const runtime = new PiCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["pi"],
      requestTimeoutMs: 500,
      spawnProcess: (launch) => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          signalCode: null,
        });
        const process = child as unknown as ChildProcessWithoutNullStreams;
        process.kill = () => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return true;
        };
        const extension = launch.extensionPaths?.[0];
        launches.push(launch.argv);
        const source = extension ? readFileSync(extension, "utf8") : "";
        const handlers = source.includes("Internal Paseo catalog provenance")
          ? loadBridge(source, directory)
          : Promise.resolve(new Map<string, Handler>());
        async function handleCommand(command: {
          id: string;
          type: string;
          provider: string;
          modelId: string;
          message: string;
        }) {
          const commands = await handlers;
          let data: unknown = {};
          switch (command.type) {
            case "get_available_models":
              data = { models };
              break;
            case "get_commands":
              data = {
                commands: [...commands.keys()].map((name) => ({
                  name,
                  description: "catalog",
                  source: "extension",
                })),
              };
              break;
            case "get_state":
              data = {
                model: selected,
                sessionId: "saved",
                sessionFile: "/saved/pi.jsonl",
                thinkingLevel: "high",
                isStreaming: false,
                isCompacting: false,
                messageCount: 0,
                pendingMessageCount: 0,
              };
              break;
            case "set_model":
              selected = { provider: command.provider, id: command.modelId, input: ["text"] };
              data = selected;
              break;
            case "get_messages":
              data = {
                messages: [
                  {
                    role: "assistant",
                    provider: "minimax",
                    model: "MiniMax-M2.7",
                    content: [{ type: "text", text: "saved answer" }],
                  },
                ],
              };
              break;
            case "prompt": {
              const handler = commands.get(command.message.slice(1));
              if (handler)
                await handler("", {
                  modelRegistry: registry,
                  ui: {
                    notify: (message: string) => {
                      notifications.push(message);
                      child.stdout.write(
                        JSON.stringify({
                          type: "extension_ui_request",
                          id: "catalog",
                          method: "notify",
                          message,
                          notifyType: "info",
                        }) + "\n",
                      );
                    },
                  },
                });
              data = { agentInvoked: !handler };
              break;
            }
          }
          child.stdout.write(
            JSON.stringify({
              id: command.id,
              type: "response",
              command: command.type,
              success: true,
              data,
            }) + "\n",
          );
        }
        let buffer = "";
        child.stdin.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const command = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            frames.push(command);
            void handleCommand(command);
          }
        });
        return process;
      },
    });
    try {
      const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime });
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: directory,
        force: false,
      });
      const visible = filterPickerAgentModels(catalog.models).map((model) => model.id);
      const unknown = ["unsupported", "broken-config", "registry-error"].includes(scenario);
      expect(visible.includes("minimax/MiniMax-M2.7")).toBe(scenario !== "builtin");
      expect(visible.includes("minimax-cn/MiniMax-M2.7")).toBe(unknown);
      if (!unknown) {
        expect(visible.indexOf("minimax-cn/MiniMax-M3.1-Flash")).toBeLessThan(
          visible.indexOf("minimax-cn/MiniMax-M3"),
        );
        expect(visible).toContain("openrouter/minimax/minimax-m3.1-flash:free");
        expect(visible).not.toContain("openrouter/minimax/minimax-m2.7");
      }
      expect(visible).toEqual(
        expect.arrayContaining([
          "custom/MiniMax-M2.7",
          "minimax/MiniMax-M3-image",
          "minimax/MiniMax-M2.1",
          "openai/gpt-other",
        ]),
      );
      expect(catalog.models).toHaveLength(models.length);
      expect(models).toEqual(originalModels);
      expect(notifications.join("\n")).not.toContain("must-not-leave-runtime");
      expect(
        validateAgentConfigurationAgainstProvider({
          input: { provider: "pi", model: "minimax/MiniMax-M2.7" },
          provider: { provider: "pi", status: "ready", enabled: true, models: catalog.models },
        }),
      ).toEqual([]);
      if (scenario === "builtin") {
        expect(catalog.models.find((model) => model.id === "minimax/MiniMax-M2.7")).toMatchObject({
          isDefault: true,
          isVisibleInPicker: false,
        });
        expect(filterPickerAgentModels(catalog.models).some((model) => model.isDefault)).toBe(
          false,
        );
      }
      // Exercise the actual native JSONL serializer for explicit model switches,
      // saved history and multimodal prompts without provider inference.
      for (const model of [
        "minimax/MiniMax-M3.1-Flash",
        "minimax/MiniMax-M3",
        "minimax/MiniMax-M2.7",
        "custom/MiniMax-M2.7",
      ]) {
        const agent = await client.createSession({
          provider: "pi",
          cwd: directory,
          model,
          thinkingOptionId: "high",
        });
        expect(launches.at(-1)).toEqual(
          expect.arrayContaining(["--model", model, "--thinking", "high"]),
        );
        await agent.close();
      }
      const switchCount = frames.filter((frame) => frame.type === "set_model").length;
      const resumed = await client.resumeSession({
        provider: "pi",
        sessionId: "saved",
        nativeHandle: "/saved/pi.jsonl",
        metadata: { cwd: directory, model: "minimax/MiniMax-M2.7", thinkingOptionId: "high" },
      });
      try {
        expect(launches.at(-1)).toEqual(expect.arrayContaining(["--session", "/saved/pi.jsonl"]));
        expect(frames.filter((frame) => frame.type === "set_model")).toHaveLength(switchCount);
        expect(await resumed.getRuntimeInfo()).toMatchObject({ model: "minimax/MiniMax-M2.7" });
      } finally {
        await resumed.close();
      }
      const nativeSession = await runtime.startSession({
        cwd: directory,
        session: "/saved/pi.jsonl",
      });
      try {
        await nativeSession.setModel("custom", "MiniMax-M2.7");
        await nativeSession.prompt("inspect", [
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ]);
        expect(await nativeSession.getMessages()).toEqual([
          {
            role: "assistant",
            provider: "minimax",
            model: "MiniMax-M2.7",
            content: [{ type: "text", text: "saved answer" }],
          },
        ]);
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "set_model",
            provider: "custom",
            modelId: "MiniMax-M2.7",
          }),
        );
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "prompt",
            message: "inspect",
            images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
          }),
        );
      } finally {
        await nativeSession.close();
      }
      expect(
        frames.some(
          (frame) => frame.type === "prompt" && String(frame.message).startsWith("/paseo_catalog_"),
        ),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not send an unadvertised command and bounds missing notifications", async () => {
    const runtime = new FakePi();
    const session = await runtime.startSession({ cwd: "/workspace" });
    const bridge = createPiCatalogBridge();
    expect(await readPiCatalogProvenance(session, bridge)).toBeUndefined();
    expect(session.prompts).toEqual([]);
    session.commands = [{ name: bridge.command, description: "catalog", source: "extension" }];
    expect(await readPiCatalogProvenance(session, bridge, undefined, 5)).toBeUndefined();
    const controller = new AbortController();
    const result = readPiCatalogProvenance(session, bridge, controller.signal);
    controller.abort(new Error("catalog cancelled"));
    await expect(result).rejects.toThrow("catalog cancelled");
  });
});
