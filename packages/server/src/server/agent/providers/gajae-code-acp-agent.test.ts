import { afterEach, describe, expect, test, vi } from "vitest";

import {
  cleanupGajaeCodeProbeSession,
  transformGajaeCodeConfigOptions,
  transformGajaeCodeSessionResponse,
} from "./gajae-code-acp-agent.js";

describe("GajaeCodeACPAgentClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("closes and deletes temporary Gajae probe sessions", async () => {
    const requests: string[] = [];
    const connection = {
      async unstable_closeSession(params: { sessionId: string }) {
        requests.push(`close:${params.sessionId}`);
        return {};
      },
      async extMethod(method: string, params: { sessionId: string }) {
        requests.push(`${method}:${params.sessionId}`);
        return {};
      },
    };

    await cleanupGajaeCodeProbeSession(connection, "session-1");

    expect(requests).toEqual(["close:session-1", "session/delete:session-1"]);
  });

  test("deletes temporary Gajae probe sessions even when close fails", async () => {
    const requests: string[] = [];
    const connection = {
      async unstable_closeSession(params: { sessionId: string }) {
        requests.push(`close:${params.sessionId}`);
        throw new Error("close failed");
      },
      async extMethod(method: string, params: { sessionId: string }) {
        requests.push(`${method}:${params.sessionId}`);
        return {};
      },
    };

    await expect(cleanupGajaeCodeProbeSession(connection, "session-1")).rejects.toThrow(
      "close failed",
    );
    expect(requests).toEqual(["close:session-1", "session/delete:session-1"]);
  });

  test("deletes temporary Gajae probe sessions when close hangs", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const connection = {
      async unstable_closeSession(params: { sessionId: string }) {
        requests.push(`close:${params.sessionId}`);
        return new Promise<never>(() => {});
      },
      async extMethod(method: string, params: { sessionId: string }) {
        requests.push(`${method}:${params.sessionId}`);
        return {};
      },
    };
    let cleanupError: unknown;

    void cleanupGajaeCodeProbeSession(connection, "session-1").catch((error: unknown) => {
      cleanupError = error;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toEqual(["close:session-1", "session/delete:session-1"]);
    expect(cleanupError).toEqual(expect.any(Error));
  });

  test("categorizes Gajae model and thinking selectors for Paseo", () => {
    expect(
      transformGajaeCodeConfigOptions([
        {
          id: "mode",
          name: "Mode",
          type: "select",
          category: "mode",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan" },
          ],
        },
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "openai/gpt-5",
          options: [{ value: "openai/gpt-5", name: "GPT-5" }],
        },
        {
          id: "thinking",
          name: "Thinking",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
        {
          id: "steeringMode",
          name: "Steering queue",
          type: "select",
          category: "queue",
          currentValue: "all",
          options: [{ value: "all", name: "All" }],
        },
      ]),
    ).toEqual([
      {
        id: "mode",
        name: "Mode",
        type: "select",
        category: "mode",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "openai/gpt-5",
        options: [{ value: "openai/gpt-5", name: "GPT-5" }],
      },
      {
        id: "thinking",
        name: "Thinking",
        type: "select",
        category: "thought_level",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
      {
        id: "steeringMode",
        name: "Steering queue",
        type: "select",
        category: "queue",
        currentValue: "all",
        options: [{ value: "all", name: "All" }],
      },
    ]);
  });

  test("preserves an active Gajae plan mode so Paseo matches the running session", () => {
    expect(
      transformGajaeCodeSessionResponse({
        sessionId: "session-1",
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        configOptions: [
          {
            id: "mode",
            name: "Mode",
            type: "select",
            currentValue: "plan",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ],
      }),
    ).toEqual({
      sessionId: "session-1",
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          category: "mode",
          currentValue: "plan",
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    });
  });

  test("does not advertise an inactive Gajae plan mode that the ACP host cannot activate", () => {
    expect(
      transformGajaeCodeSessionResponse({
        sessionId: "session-1",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        configOptions: [],
      }),
    ).toEqual({
      sessionId: "session-1",
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
      configOptions: [],
    });
  });
});
