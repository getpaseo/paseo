import type {
  PluginExecutionStartInput,
  PluginExecutionModeContribution,
} from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getExecutionModes, startPluginExecution } from "./execution";
import type { InstalledPlugin } from "./types";
import { runSubmissionChecks } from "./submission-checks";
import { openSubmissionDecision, SubmissionCancelledError } from "./submission-decision";
import type { PluginSubmissionCheckInput, PluginSubmissionDecision } from "@getpaseo/plugin/client";

function fixture(
  start: PluginExecutionModeContribution["start"] = vi.fn(async () => ({ agentId: "boss" })),
): InstalledPlugin {
  return {
    id: "crew",
    serverId: "host",
    lifetime: new AbortController(),
    cleanup() {},
    clientBundle: "",
    queryClient: new QueryClient(),
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    executionModes: [
      {
        id: "team",
        title: "Team",
        icon: "Blocks",
        async loadPresets() {
          return { presets: [] };
        },
        start,
      },
    ],
  };
}

const input = {
  workspaceId: "workspace",
  cwd: "/project",
  presetId: "standard",
  text: "Keep the original request",
  images: [{ data: "image", mimeType: "image/png" }],
  attachments: [],
  idempotencyKey: "draft",
  defaultAgentConfig: { provider: "codex/model", thinkingOptionId: "medium" },
};

describe("plugin execution", () => {
  it("uses host-scoped namespaced modes and removes disabled contributions", () => {
    const plugin = fixture();
    expect(getExecutionModes([plugin], "other")).toEqual([]);
    expect(getExecutionModes([plugin], "host").map((mode) => mode.id)).toEqual(["crew:team"]);
    plugin.lifetime.abort();
    expect(getExecutionModes([plugin], "host")).toEqual([]);
  });

  it("deduplicates concurrent starts while preserving rich input and permits an idempotent retry after failure", async () => {
    let release!: (value: { agentId: string }) => void;
    const start = vi.fn(
      (_request: PluginExecutionStartInput) =>
        new Promise<{ agentId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const plugin = fixture(start);
    const mode = getExecutionModes([plugin], "host")[0]!;
    const first = startPluginExecution(mode, input);
    const second = startPluginExecution(mode, input);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(input);
    release({ agentId: "boss" });
    expect(await first).toEqual(await second);
    start.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await expect(startPluginExecution(mode, input)).rejects.toThrow("offline");
    const retry = startPluginExecution(mode, input);
    await Promise.resolve();
    release({ agentId: "boss" });
    await expect(retry).resolves.toEqual({ agentId: "boss" });
    expect(start.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      "draft",
      "draft",
      "draft",
    ]);
  });

  it("rejects removed modes before executing a paid start", async () => {
    const plugin = fixture();
    const mode = getExecutionModes([plugin], "host")[0]!;
    plugin.executionModes = [];
    await expect(startPluginExecution(mode, input)).rejects.toThrow("unavailable");
    expect(mode.contribution.start).not.toHaveBeenCalled();
  });
});

const submissionInput: PluginSubmissionCheckInput = {
  ...input,
  projectId: "project",
  projectName: "Existing project",
  projectRootPath: "/project",
  executionId: "",
  routingMode: "manual",
};
const decision: PluginSubmissionDecision = {
  title: "Choose a project",
  choices: [
    { id: "keep", title: "Keep project" },
    { id: "new", title: "New project" },
  ],
  textInput: { label: "Project name", initialValue: "kin" },
  timeout: { seconds: 60, choiceId: "keep" },
};

describe("submission checks", () => {
  it.each(["", "crew:team"])(
    "checks %s before dispatch, keeps rich manual input and reuses a resolved retry",
    async (executionId) => {
      const plugin = fixture();
      const check = vi.fn(async () => decision);
      const resolve = vi.fn(async () => ({ cwd: "/projects/kin", projectId: "kin" }));
      plugin.submissionChecks = [{ id: "intake", check, resolve }];
      const signal = new AbortController().signal;
      let answer!: () => void;
      const present = vi.fn(
        () =>
          new Promise<{ choiceId: string; textValue: string; automatic: boolean }>((finish) => {
            answer = () => finish({ choiceId: "new", textValue: "kin", automatic: false });
          }),
      );
      const request = { ...submissionInput, executionId, idempotencyKey: `draft:${executionId}` };
      const options = { plugins: [plugin], serverId: "host", input: request, signal, present };
      const start = vi.fn();
      const pending = runSubmissionChecks(options).then(start);
      const concurrent = runSubmissionChecks(options);
      await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
      expect(start).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledWith(request, { signal: expect.any(AbortSignal) });
      answer();
      await pending;
      await expect(concurrent).resolves.toEqual({ cwd: "/projects/kin", projectId: "kin" });
      expect(start).toHaveBeenCalledWith({ cwd: "/projects/kin", projectId: "kin" });
      await runSubmissionChecks(options);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(request.text).toBe(input.text);
      expect(request.images).toEqual(input.images);
      expect(request.defaultAgentConfig).toEqual(input.defaultAgentConfig);
      expect(request.routingMode).toBe("manual");
    },
  );

  it("uses only the selected host and cancels removed plugins before resolution", async () => {
    const plugin = fixture();
    const resolve = vi.fn(async () => undefined);
    plugin.submissionChecks = [{ id: "intake", check: async () => decision, resolve }];
    const present = vi.fn(async () => {
      plugin.lifetime.abort();
      return { choiceId: "keep", automatic: false };
    });
    const options = {
      plugins: [plugin],
      serverId: "other",
      input: submissionInput,
      signal: new AbortController().signal,
      present,
    };
    await expect(runSubmissionChecks(options)).resolves.toBeUndefined();
    expect(present).not.toHaveBeenCalled();
    await expect(runSubmissionChecks({ ...options, serverId: "host" })).rejects.toBeInstanceOf(
      SubmissionCancelledError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("prevents a check from recursively awaiting itself", async () => {
    const plugin = fixture();
    const options = {
      plugins: [plugin],
      serverId: "host",
      input: { ...submissionInput, idempotencyKey: "recursive" },
      signal: new AbortController().signal,
      caller: plugin,
      present: vi.fn(async () => ({ choiceId: "keep", automatic: false })),
    };
    plugin.submissionChecks = [
      {
        id: "intake",
        check: async () => {
          await runSubmissionChecks(options);
        },
        resolve: async () => undefined,
      },
    ];
    await expect(runSubmissionChecks(options)).rejects.toThrow("recursively");
  });

  it("does not reuse a completed decision after its contribution is replaced", async () => {
    const plugin = fixture();
    const options = {
      plugins: [plugin],
      serverId: "host",
      input: { ...submissionInput, idempotencyKey: "replacement" },
      signal: new AbortController().signal,
      present: vi.fn(async () => ({ choiceId: "new", automatic: false })),
    };
    plugin.submissionChecks = [
      { id: "intake", check: async () => decision, resolve: async () => ({ cwd: "/kin" }) },
    ];
    await expect(runSubmissionChecks(options)).resolves.toEqual({ cwd: "/kin" });
    const check = vi.fn(async () => undefined);
    plugin.submissionChecks = [{ id: "intake", check, resolve: vi.fn() }];
    await expect(runSubmissionChecks(options)).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledOnce();
    expect(options.present).toHaveBeenCalledOnce();
  });

  it("uses the timed choice only while untouched and clears timers after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const model = openSubmissionDecision(decision, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(model.result).resolves.toEqual({
        choiceId: "keep",
        textValue: "kin",
        automatic: true,
      });
      expect(vi.getTimerCount()).toBe(0);
      const edited = openSubmissionDecision(decision, new AbortController().signal);
      edited.interact();
      edited.setText("new-product");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(edited.getState()).toMatchObject({
        closed: false,
        timerActive: false,
        textValue: "new-product",
      });
      edited.choose("new");
      await expect(edited.result).resolves.toEqual({
        choiceId: "new",
        textValue: "new-product",
        automatic: false,
      });
      const controller = new AbortController();
      const cancelled = openSubmissionDecision(decision, controller.signal);
      controller.abort();
      await expect(cancelled.result).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
