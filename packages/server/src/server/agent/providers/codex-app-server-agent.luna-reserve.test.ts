import { describe, expect, test, vi } from "vitest";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const LUNA = "gpt-5.6-luna";
const USAGE_LIMIT = {
  message: "You've hit your usage limit.",
  codexErrorInfo: "usageLimitExceeded",
};

const reserveOffered = {
  accountId: "account-a",
  ordinaryUsageAllowed: false,
  rateLimits: { limitId: "codex", primary: { usedPercent: 100 } },
  rateLimitsByLimitId: {
    base_model_inference: {
      limitId: "base_model_inference",
      limitName: "gpt-reserve",
      normalModelSlug: LUNA,
    },
  },
  rateLimitUpsell: { banner_type: "luna_reserve", title: "Luna Reserve", ctas: [] },
};

const ordinaryAllowed = {
  accountId: "account-a",
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: "codex", primary: { usedPercent: 1 } },
  rateLimitsByLimitId: null,
  rateLimitUpsell: null,
};

interface ReserveTest {
  appServer: FakeCodexAppServer;
  session: CodexAppServerAgentSession;
  events: AgentStreamEvent[];
  setRateLimits(response: unknown): void;
  turnStarts(): Array<Record<string, unknown>>;
  rateLimitReads(): Array<Record<string, unknown>>;
  waitForTurnStarts(count: number): Promise<void>;
  nextTerminal(): Promise<AgentStreamEvent>;
}

function startReserveTest(model: string): ReserveTest {
  let rateLimits: unknown = reserveOffered;
  const appServer = createFakeCodexAppServer({
    "account/rateLimits/read": () => rateLimits,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", modeId: "auto", model },
    null,
    createTestLogger(),
    async () => appServer.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const requestsFor = (method: string) =>
    appServer
      .requests()
      .filter((request) => request.method === method)
      .map((request) => request.params as Record<string, unknown>);
  return {
    appServer,
    session,
    events,
    setRateLimits: (response) => {
      rateLimits = response;
    },
    turnStarts: () => requestsFor("turn/start"),
    rateLimitReads: () => requestsFor("account/rateLimits/read"),
    waitForTurnStarts: (count) =>
      vi.waitFor(() => expect(requestsFor("turn/start")).toHaveLength(count)),
    nextTerminal: () => {
      const seen = events.length;
      return vi.waitFor(() => {
        const terminal = events
          .slice(seen)
          .find((event) => event.type === "turn_completed" || event.type === "turn_failed");
        if (!terminal) throw new Error("no terminal event yet");
        return terminal;
      });
    },
  };
}

function inputText(turnStart: Record<string, unknown>): string {
  const input = turnStart.input as Array<{ type: string; text?: string }>;
  return input.map((part) => part.text ?? "").join("");
}

function notices(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "notification" ? [event.item.message] : [],
  );
}

describe("Luna Reserve fallback", () => {
  test("continues a Luna turn that hits the usage limit on Luna Reserve", async () => {
    const t = startReserveTest(LUNA);
    try {
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });

      await t.waitForTurnStarts(2);
      const [first, second] = t.turnStarts();
      expect(first.model).toBe(LUNA);
      expect(second.model).toBe("gpt-reserve");
      expect(second.serviceTier).toBe("default");
      expect(inputText(second)).toBe("Continue.");
      expect(t.rateLimitReads()).toEqual([
        { supportsLunaReserve: true, excludeResetCreditDetails: true },
      ]);
      expect(notices(t.events)).toEqual([
        "Ordinary Codex usage is used up. Continuing on Luna Reserve until it is available again.",
      ]);

      const terminal = t.nextTerminal();
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-2" });
      t.appServer.completeTurn({ status: "completed" });
      expect((await terminal).type).toBe("turn_completed");
      expect(t.events.some((event) => event.type === "turn_failed")).toBe(false);
      t.appServer.assertNoErrors();
    } finally {
      await t.session.close();
    }
  });

  test("reports the usage limit for any other model", async () => {
    const t = startReserveTest("gpt-5.6-sol");
    try {
      const terminal = t.nextTerminal();
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });

      expect(await terminal).toMatchObject({ type: "turn_failed", error: USAGE_LIMIT.message });
      expect(t.turnStarts()).toHaveLength(1);
      expect(notices(t.events)).toEqual([]);
    } finally {
      await t.session.close();
    }
  });

  test("reports the usage limit when the account has no reserve", async () => {
    const t = startReserveTest(LUNA);
    t.setRateLimits({ ...reserveOffered, rateLimitUpsell: null });
    try {
      const terminal = t.nextTerminal();
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });

      expect(await terminal).toMatchObject({ type: "turn_failed", error: USAGE_LIMIT.message });
      expect(t.turnStarts()).toHaveLength(1);
    } finally {
      await t.session.close();
    }
  });

  test("leaves other failures alone", async () => {
    const t = startReserveTest(LUNA);
    try {
      const terminal = t.nextTerminal();
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({
        status: "failed",
        error: { message: "Server overloaded", codexErrorInfo: "serverOverloaded" },
      });

      expect(await terminal).toMatchObject({ type: "turn_failed", error: "Server overloaded" });
      expect(t.rateLimitReads()).toEqual([]);
    } finally {
      await t.session.close();
    }
  });

  test("reports the limit when the reserve runs out too", async () => {
    const t = startReserveTest(LUNA);
    try {
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });
      await t.waitForTurnStarts(2);

      const terminal = t.nextTerminal();
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-2" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });

      expect(await terminal).toMatchObject({ type: "turn_failed", error: USAGE_LIMIT.message });
      expect(t.turnStarts()).toHaveLength(2);
      expect(t.rateLimitReads()).toHaveLength(1);
    } finally {
      await t.session.close();
    }
  });

  test("stays on the reserve until ordinary usage is allowed, then switches back", async () => {
    const t = startReserveTest(LUNA);
    try {
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });
      await t.waitForTurnStarts(2);
      let terminal = t.nextTerminal();
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-2" });
      t.appServer.completeTurn({ status: "completed" });
      await terminal;

      // Still blocked: the next prompt runs on the reserve straight away.
      await t.session.startTurn("now the tests");
      await t.waitForTurnStarts(3);
      expect(t.turnStarts()[2]).toMatchObject({ model: "gpt-reserve" });
      expect(inputText(t.turnStarts()[2])).toBe("now the tests");
      terminal = t.nextTerminal();
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-3" });
      t.appServer.completeTurn({ status: "completed" });
      await terminal;

      t.setRateLimits(ordinaryAllowed);
      await t.session.startTurn("and the docs");
      await t.waitForTurnStarts(4);
      expect(t.turnStarts()[3]).toMatchObject({ model: LUNA });
      expect(notices(t.events).at(-1)).toBe(
        `Ordinary Codex usage is available again. Back on ${LUNA}.`,
      );
      t.appServer.assertNoErrors();
    } finally {
      await t.session.close();
    }
  });

  test("drops the reserve when the agent is moved to another model", async () => {
    const t = startReserveTest(LUNA);
    try {
      await t.session.startTurn("refactor the parser");
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
      t.appServer.completeTurn({ status: "failed", error: USAGE_LIMIT });
      await t.waitForTurnStarts(2);
      const terminal = t.nextTerminal();
      t.appServer.startsTurn({ threadId: "thread-1", turnId: "native-2" });
      t.appServer.completeTurn({ status: "completed" });
      await terminal;

      await t.session.setModel("gpt-5.6-sol");
      await t.session.startTurn("harder problem");
      await t.waitForTurnStarts(3);
      expect(t.turnStarts()[2]).toMatchObject({ model: "gpt-5.6-sol" });
      expect(t.rateLimitReads()).toHaveLength(1);
    } finally {
      await t.session.close();
    }
  });
});
