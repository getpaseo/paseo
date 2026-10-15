import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { classifyExecution, classifyInitialExecution, routes } from "./execution-routing";

const env = { TYPESAFE_API_KEY: "test-key" };
const categories = routes.map((route) => route.category);

function answer(
  choice: (typeof categories)[number],
  confidence = 0.8,
  probabilities = Object.fromEntries(
    categories.map((category) => [category, category === choice ? 0.8 : 0.05]),
  ),
) {
  return {
    model: "jev-1.13.0",
    answers: { execution: { type: "choice", choice, confidence, probabilities } },
  };
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.useRealTimers());

test.each(routes)("maps $category to the fixed $model/$effort route", async (route) => {
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => response(answer(route.category)),
    }),
  ).resolves.toMatchObject({ ...route, provider: "codex" });
});

test("sends the full plan and never returns the API key", async () => {
  let request!: RequestInit;
  const decision = await classifyExecution("plan complet", undefined, {
    env,
    fetch: async (_url, init) => {
      request = init!;
      return response(answer("bounded"));
    },
  });
  expect(request.headers).toMatchObject({ Authorization: "Bearer test-key" });
  expect(JSON.parse(String(request.body))).toMatchObject({
    model: "jev-1.13.0",
    state: "plan complet",
  });
  expect(JSON.stringify(decision)).not.toContain("test-key");
});

test("classifies the initial request according to the selected Plan or Execute mode", async () => {
  const states: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    states.push(JSON.parse(String(init?.body)).state);
    return response(answer("bounded"));
  };
  await classifyInitialExecution({ prompt: "Ajouter Auto", modeId: "plan" }, undefined, {
    env,
    fetch,
  });
  await classifyInitialExecution(
    { prompt: "Ajouter Auto", modeId: "default", workspaceIntent: "Mobile app" },
    undefined,
    { env, fetch },
  );
  expect(states).toEqual([
    expect.stringContaining("difficulty of designing the plan"),
    expect.stringContaining("difficulty of implementing the request"),
  ]);
  expect(states[1]).toContain("Workspace intention:\nMobile app");
});

test.each([
  { modeId: "default", featureValues: { plan_mode: true }, planning: true },
  { modeId: "plan", featureValues: { plan_mode: false }, planning: false },
  { modeId: "codex#plan", featureValues: undefined, planning: true },
  { modeId: "plan", featureValues: { plan_mode: "false" }, planning: true },
])(
  "classifies initial mode with feature precedence: $modeId / $featureValues",
  async ({ planning, ...input }) => {
    let state = "";
    await classifyInitialExecution({ prompt: "Ajouter Auto", ...input }, undefined, {
      env,
      fetch: async (_url, init) => {
        state = JSON.parse(String(init?.body)).state;
        return response(answer("bounded"));
      },
    });
    expect(state).toContain(
      planning ? "difficulty of designing the plan" : "difficulty of implementing the request",
    );
  },
);

test("rejects confidence below 0.5 and accepts the threshold", async () => {
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => response(answer("bounded", 0.49)),
    }),
  ).rejects.toThrow("insuffisamment confiant");
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => response(answer("bounded", 0.5)),
    }),
  ).resolves.toMatchObject({ category: "bounded" });
});

test("accepts a low-confidence but coherent initial classification", async () => {
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).state).toContain(
      "difficulty of implementing the request",
    );
    return response(
      answer("bounded", 0.38, {
        trivial: 0.15,
        bounded: 0.38,
        diagnostic: 0.18,
        complex: 0.15,
        critical: 0.14,
      }),
    );
  };
  await expect(
    classifyInitialExecution({ prompt: "Ajouter Auto", modeId: "default" }, undefined, {
      env,
      fetch,
    }),
  ).resolves.toMatchObject({ category: "bounded", model: "gpt-5.6-sol", effort: "medium" });
});

test("rejects a choice that disagrees with its probability distribution", async () => {
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () =>
        response(
          answer("bounded", 0.8, {
            trivial: 0.8,
            bounded: 0.05,
            diagnostic: 0.05,
            complex: 0.05,
            critical: 0.05,
          }),
        ),
    }),
  ).rejects.toThrow("incohérent");
});

test("uses the first non-empty environment key and rejects a missing key", async () => {
  let authorization: string | undefined;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
    return response(answer("trivial"));
  };
  await classifyExecution("plan", undefined, {
    env: { TYPESAFE_API_KEY: "primary-key", "JEV-API-KEY": "alias-key" },
    fetch,
  });
  expect(authorization).toBe("Bearer primary-key");
  await classifyExecution("plan", undefined, {
    env: { TYPESAFE_API_KEY: "  ", "JEV-API-KEY": "alias-key" },
    fetch,
  });
  expect(authorization).toBe("Bearer alias-key");
  const emptyHome = await mkdtemp(path.join(os.tmpdir(), "paseo-workflow-empty-"));
  try {
    await expect(
      classifyExecution("plan", undefined, { env: { PASEO_HOME: emptyHome }, fetch }),
    ).rejects.toThrow("clé JEV est absente");
  } finally {
    await rm(emptyHome, { force: true, recursive: true });
  }
});

test("reads dotenv syntax from PASEO_HOME, including a tilde-prefixed home", async () => {
  const directory = await mkdtemp(path.join(os.homedir(), "paseo-workflow-test-"));
  try {
    await writeFile(
      path.join(directory, "paseo-workflow.env"),
      'export JEV-API-KEY="file-key" # local key\n',
    );
    let authorization: string | undefined;
    await classifyExecution("plan", undefined, {
      env: { PASEO_HOME: `~/${path.basename(directory)}` },
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
        return response(answer("trivial"));
      },
    });
    expect(authorization).toBe("Bearer file-key");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("does not start a request when the signal is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn(async () => response(answer("trivial")));
  await expect(classifyExecution("plan", controller.signal, { env, fetch })).rejects.toThrow(
    /annul/i,
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("propagates a caller cancellation and aborts after fifteen seconds", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pendingFetch = async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      started();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const controller = new AbortController();
  const cancelled = classifyExecution("plan", controller.signal, { env, fetch: pendingFetch });
  await startedPromise;
  controller.abort();
  await expect(cancelled).rejects.toThrow();

  const timeoutStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.useFakeTimers();
  const timedOut = classifyExecution("plan", undefined, { env, fetch: pendingFetch });
  await timeoutStarted;
  const timedOutExpectation = expect(timedOut).rejects.toThrow("15 secondes");
  await vi.advanceTimersByTimeAsync(15_000);
  await timedOutExpectation;
});

test.each([401, 429, 500])("reports HTTP %i in French", async (status) => {
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => new Response(null, { status }),
    }),
  ).rejects.toThrow(`HTTP ${status}`);
});

test("reports network and invalid JSON failures in French", async () => {
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
    }),
  ).rejects.toThrow(/joindre|réseau/i);
  await expect(
    classifyExecution("plan", undefined, {
      env,
      fetch: async () => new Response("not-json", { status: 200 }),
    }),
  ).rejects.toThrow(/invalide/i);
});
