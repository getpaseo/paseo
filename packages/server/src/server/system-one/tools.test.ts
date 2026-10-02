import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import {
  SYSTEM_ONE_CALL_EXAMPLE,
  SYSTEM_ONE_INSTRUCTION,
} from "../agent/writing-block-instruction.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { SystemOneCredentialStore } from "./credential-store.js";
import { createConfiguredSystemOneDecisionSource, registerSystemOneTools } from "./tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("registerSystemOneTools", () => {
  it("batches typed questions through the configured Paseo credential", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-system-one-tools-"));
    temporaryDirectories.push(paseoHome);
    new SystemOneCredentialStore(paseoHome, { env: {}, sharedEnvFile: "/missing" }).set(
      "private-key",
    );
    let requestBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              route: {
                choice: "inspect",
                confidence: 0.9,
                probabilities: { inspect: 0.9, implement: 0.1 },
              },
              risky: { noul: 0.2 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    let handler: ((input: unknown) => Promise<PaseoToolResult>) | null = null;
    let toolConfig: PaseoToolConfig | null = null;
    registerSystemOneTools({
      paseoHome,
      daemonConfigStore: {
        get: () =>
          ({
            systemOne: {
              enabled: true,
              model: "jev-latest",
              endpoint: "https://api.typesafe.ai/v1/systemone",
              minimumConfidence: 0.7,
              configured: true,
              credentialSource: "paseo",
            },
          }) as ReturnType<DaemonConfigStore["get"]>,
      },
      registerTool: (_name: string, _config: PaseoToolConfig, registeredHandler) => {
        toolConfig = _config;
        handler = registeredHandler;
      },
    });

    expect(handler).not.toBeNull();
    if (!toolConfig) throw new Error("Expected System One tool registration");
    const example = JSON.parse(SYSTEM_ONE_CALL_EXAMPLE) as unknown;
    expect(toolConfig.description).toContain(SYSTEM_ONE_CALL_EXAMPLE);
    expect(SYSTEM_ONE_INSTRUCTION).toContain(SYSTEM_ONE_CALL_EXAMPLE);
    expect(
      (toolConfig.inputSchema as { safeParse(input: unknown): { success: boolean } }).safeParse(
        example,
      ).success,
    ).toBe(true);
    expect(
      (toolConfig.inputSchema as { safeParse(input: unknown): { success: boolean } }).safeParse({
        state: { apiKey: "must-not-leave-host" },
        questions: {
          route: {
            type: "choice",
            instructions: "Choose",
            criteria: { a: "A", b: "B" },
          },
        },
      }).success,
    ).toBe(false);
    const result = await handler!({
      state: { task: "Fix the failing settings flow" },
      questions: {
        route: {
          type: "choice",
          instructions: "What should happen next?",
          criteria: { inspect: "Inspect evidence", implement: "Implement the fix" },
        },
        risky: { type: "noul", instructions: "Is the proposed change high risk?" },
      },
    });

    expect(requestBody).toMatchObject({ model: "jev-latest" });
    expect(requestBody?.questions).toBeDefined();
    expect(result.structuredContent).toMatchObject({ minimumConfidence: 0.7 });
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("forwards the caller deadline to the actual configured TypeSafe request", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-routing-deadline-"));
    temporaryDirectories.push(paseoHome);
    new SystemOneCredentialStore(paseoHome, { env: {}, sharedEnvFile: "/missing" }).set(
      "fixture-only",
    );
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init!.signal as AbortSignal;
            signal.addEventListener(
              "abort",
              reject.bind(null, new DOMException("deadline", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const source = createConfiguredSystemOneDecisionSource(paseoHome, {
      get: () =>
        ({ systemOne: { enabled: true, model: "jev-latest" } }) as ReturnType<
          DaemonConfigStore["get"]
        >,
    });
    const controller = new AbortController();
    const pending = source.decide(
      {
        state: { task: "Choose a route" },
        questions: { route: { type: "choice", criteria: { a: "First" } } },
      },
      { signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    await assertion;
    expect(signal!.aborted).toBe(true);
  });

  it("falls back to the next key when TypeSafe rejects the saved one", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-system-one-tools-"));
    temporaryDirectories.push(paseoHome);
    const sharedEnvFile = path.join(paseoHome, "typesafe.env");
    await writeFile(sharedEnvFile, "TYPESAFE_API_KEY=working-key\n");
    new SystemOneCredentialStore(paseoHome, { env: {}, sharedEnvFile }).set("stale-key");
    const usedKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
        usedKeys.push(key);
        if (key === "stale-key") return new Response("{}", { status: 401 });
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: { q: { choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } } },
          }),
        );
      }),
    );
    const source = createConfiguredSystemOneDecisionSource(paseoHome, {
      get: () => ({
        systemOne: {
          enabled: true,
          model: "jev-latest",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          minimumConfidence: 0.5,
        },
      }),
    } as unknown as Pick<DaemonConfigStore, "get">);
    const previous = process.env.TYPESAFE_ENV_FILE;
    const previousApiKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_ENV_FILE = sharedEnvFile;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const result = await source.decide({
        state: {},
        questions: { q: { type: "choice", criteria: { a: "A", b: "B" } } },
      });
      expect(result.model).toBe("jev-latest");
      expect(usedKeys).toEqual(["stale-key", "working-key"]);
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_ENV_FILE;
      else process.env.TYPESAFE_ENV_FILE = previous;
      if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousApiKey;
    }
  });
});
