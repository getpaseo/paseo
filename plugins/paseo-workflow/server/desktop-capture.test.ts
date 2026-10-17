import { describe, expect, it, vi } from "vitest";
import { classifyCapture } from "./desktop-capture";
const projects = [
  {
    projectId: "a",
    projectDisplayName: "Paseo",
    projectRootPath: "/code/paseo",
    projectKind: "git" as const,
  },
  {
    projectId: "b",
    projectDisplayName: "Shop",
    projectRootPath: "/code/shop",
    projectKind: "git" as const,
  },
];
const input = { text: "Corrige le projet Paseo", ocr: "Shop", context: { windowTitle: "Shop" } };

describe("desktop capture routing", () => {
  it("uses a uniquely explicit project before window context or JEV", async () => {
    const fetch = vi.fn();
    expect(await classifyCapture(input, projects, { fetch })).toMatchObject({
      projectId: "a",
      reason: "explicit",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never chooses a homonym or PARA as a worktree project", async () => {
    const duplicate = { ...projects[1], projectDisplayName: "Paseo" };
    expect(await classifyCapture(input, [projects[0], duplicate], { env: {} })).toMatchObject({
      projectId: null,
    });
    expect(
      await classifyCapture(
        { ...input, text: "projet PARA" },
        [
          {
            ...projects[0],
            projectDisplayName: "PARA",
            projectRootPath: "/Users/sylvaindivito/Desktop/PARA",
          },
        ],
        { env: {} },
      ),
    ).toMatchObject({ projectId: null });
  });
  it("falls back when there is no key, without using the active window as proof", async () => {
    expect(
      await classifyCapture({ ...input, text: "Rends ceci plus clair" }, projects, { env: {} }),
    ).toMatchObject({ projectId: null });
  });
  it("accepts only a coherent distribution above all three thresholds", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              destination: {
                type: "choice",
                choice: "p0",
                probabilities: { p0: 0.96, p1: 0.02, para: 0.02 },
                confidence: 0.94,
              },
            },
          }),
        ),
    );
    const generic = { ...input, text: "Corrige le bug" };
    expect(
      await classifyCapture(generic, projects, { env: { TYPESAFE_API_KEY: "test" }, fetch }),
    ).toMatchObject({ projectId: "a", reason: "jev" });
    fetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              destination: {
                type: "choice",
                choice: "p0",
                probabilities: { p0: 0.89, p1: 0.06, para: 0.05 },
                confidence: 0.99,
              },
            },
          }),
        ),
    );
    expect(
      await classifyCapture(generic, projects, { env: { TYPESAFE_API_KEY: "test" }, fetch }),
    ).toMatchObject({ projectId: null });
  });
  it("bounds the whole classification to two seconds even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const result = classifyCapture({ ...input, text: "Corrige ceci" }, projects, {
        env: { TYPESAFE_API_KEY: "test" },
        fetch: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toMatchObject({ projectId: null, reason: "fallback" });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("classifies destination and execution in one call", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            destination: {
              type: "choice",
              choice: "p0",
              probabilities: { p0: 0.96, p1: 0.02, para: 0.02 },
              confidence: 0.94,
            },
            execution: {
              type: "choice",
              choice: "bounded",
              probabilities: {
                trivial: 0.02,
                bounded: 0.92,
                diagnostic: 0.02,
                complex: 0.02,
                critical: 0.02,
              },
              confidence: 0.9,
            },
          },
        }),
      ),
  );
  const result = await classifyCapture({ ...input, autoModel: true }, projects, {
    env: { TYPESAFE_API_KEY: "test" },
    fetch,
  });
  expect(result).toMatchObject({
    projectId: "a",
    reason: "explicit",
    execution: { category: "bounded", provider: "codex" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves an explicit destination when automatic model routing fails", async () => {
  const result = await classifyCapture({ ...input, autoModel: true }, projects, {
    env: { TYPESAFE_API_KEY: "test" },
    fetch: async () => new Response("offline", { status: 503 }),
  });
  expect(result).toMatchObject({ projectId: "a", reason: "explicit" });
});

it("keeps the selected project through worktree failure and reuses completed creation after reload", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { captureRuntime } = await import("./desktop-capture");
  const { captureSettings } = await import("../shared/desktop-capture");
  const directory = await mkdtemp(path.join(tmpdir(), "capture-routing-"));
  let values = captureSettings.schema.parse({});
  let revision = 0;
  const settings = {
    read: async () => ({
      status: "ready" as const,
      revision: String(revision),
      values: structuredClone(values),
    }),
    write: async (next: typeof values, expected: string) => {
      expect(expected).toBe(String(revision));
      values = structuredClone(next);
      revision++;
    },
    subscribe: () => () => {},
  };
  const createWorkspace = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue({ id: "workspace" });
  const createAgent = vi.fn().mockResolvedValue({ id: "agent" });
  const api = {
    projects: {
      list: async () => ({ projects: [{ ...projects[0], projectRootPath: directory }] }),
    },
    workspaces: { create: createWorkspace, ref: () => ({ agents: { create: createAgent } }) },
  };
  const request = {
    key: "fbe38053-85c5-4e41-bf80-32be1ade6632",
    deviceId: "c7d9bf71-8110-456b-9b97-83f2d2f7bd46",
    text: input.text,
    ocr: "Texte visible",
    context: { application: "Finder", directoryPath: "/Users/test/Projet été" },
    config: { provider: "codex/gpt-6-astra", featureValues: { plan_mode: true } },
    autoModel: false,
    images: [{ data: "aGVsbG8=", mimeType: "image/png" as const }],
  };
  const create = captureRuntime(settings);
  try {
    await expect(create(request, api as Parameters<typeof create>[1])).rejects.toThrow("disk full");
    expect(values.requests[request.key].decision).toMatchObject({
      projectId: "a",
      root: directory,
    });
    const [first, second] = await Promise.all([
      create(request, api as Parameters<typeof create>[1]),
      create(request, api as Parameters<typeof create>[1]),
    ]);
    expect(first.agentId).toBe(second.agentId);
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      config: request.config,
      images: request.images,
      prompt: expect.stringContaining(request.text),
    });
    const prompt = createAgent.mock.calls[0][0].prompt;
    expect(prompt).toContain('"directoryPath": "/Users/test/Projet été"');
    expect(prompt).toContain('"screenText": "Texte visible"');
    expect(createWorkspace.mock.calls[1][0].firstAgentContext.prompt).toBe(prompt);
    await captureRuntime(settings)(request, api as Parameters<typeof create>[1]);
    expect(createAgent).toHaveBeenCalledTimes(1);
    await expect(
      create({ ...request, text: "Other request" }, api as Parameters<typeof create>[1]),
    ).rejects.toThrow("autre contenu");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("never sends screenshots to JEV", async () => {
  let state = "";
  const request = {
    ...input,
    text: "Corrige ceci",
    images: [{ data: "private-image-bytes" }],
    planMode: true,
  };
  await classifyCapture(request, projects, {
    env: { TYPESAFE_API_KEY: "test" },
    fetch: async (_url, init) => {
      state = JSON.parse(String(init?.body)).state;
      return new Response("offline", { status: 503 });
    },
  });
  expect(state).not.toContain("private-image-bytes");
  expect(JSON.parse(state)).toMatchObject({ request: "Corrige ceci", mode: "Plan" });
});
