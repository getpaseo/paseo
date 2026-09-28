import { describe, expect, it } from "vitest";
import type { BrowserToolsExecuteInput } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { JevBrowserGoalRunner, parseObservedElements } from "./jev-goal-runner.js";
import type { BrowserActivityEvent } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { BrowserActivityHub } from "./browser-activity.js";
import type {
  TypeSafeChoiceAnswer,
  TypeSafeDecisionRequest,
  TypeSafeDecisionSource,
} from "./jev-client.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT = { agentId: "agent-1", cwd: "/repo", workspaceId: "workspace-1" };

class GoalBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];
  public filledValue: string | undefined;
  public clicked = false;
  public staleClicks = false;

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    const command = input.command;
    switch (command.command) {
      case "snapshot":
        return snapshotPayload(
          this.clicked
            ? '- heading "Welcome" @e1'
            : '- textbox "Email" @e1\n- button "Continue" [ref=@e2]',
        );
      case "fill":
        this.filledValue = command.args.value;
        return success({ command: "fill", browserId: BROWSER_ID, ref: command.args.ref });
      case "click":
        if (this.staleClicks) {
          return {
            requestId: "request-stale",
            ok: false,
            error: {
              code: "browser_stale_ref",
              message: "Ref expired",
              retryable: true,
            },
          };
        }
        this.clicked = true;
        return success({ command: "click", browserId: BROWSER_ID, ref: command.args.ref });
      case "wait":
        return success({
          command: "wait",
          browserId: BROWSER_ID,
          matched: command.args.text ? "text" : "url",
        });
      default:
        throw new Error(`Unexpected browser command ${command.command}`);
    }
  }
}

class ScriptedDecisions implements TypeSafeDecisionSource {
  public readonly requests: TypeSafeDecisionRequest[] = [];

  public constructor(private readonly operations: string[]) {}

  public async decide(request: TypeSafeDecisionRequest) {
    this.requests.push(request);
    const operation = this.operations.shift();
    if (!operation) throw new Error("No scripted decision remaining");
    const answers: Record<string, TypeSafeChoiceAnswer> = {
      operation: answerFor(request, "operation", operation),
    };
    if (operation === "FILL") {
      answers.fill_target = answerFor(request, "fill_target", "1");
      answers.fill_value = answerFor(request, "fill_value", "1");
    }
    if (operation === "CLICK") {
      answers.click_target = answerFor(request, "click_target", "2");
    }
    return { answers, model: "jev-test", latencyMs: 7 };
  }
}

describe("JevBrowserGoalRunner", () => {
  it("fills locally, clicks, and only passes after deterministic verification", async () => {
    const broker = new GoalBroker();
    const decisions = new ScriptedDecisions(["FILL", "CLICK", "DONE"]);
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions });
    const secretValue = "not-sent-to-typesafe";

    const result = await runner.run(
      {
        goal: "Sign in with the account value and reach Welcome",
        browserId: BROWSER_ID,
        values: { account: { value: secretValue, description: "test account email" } },
        verify: [{ text: "Welcome" }],
      },
      CONTEXT,
    );

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.operation)).toEqual(["FILL", "CLICK"]);
    expect(broker.filledValue).toBe(secretValue);
    expect(JSON.stringify(decisions.requests)).not.toContain(secretValue);
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(broker.calls.at(-1)?.command.command).toBe("wait");
  });

  it("verifies an unsure DONE instead of stopping as uncertain", async () => {
    const broker = new GoalBroker();
    broker.clicked = true;
    const decisions: TypeSafeDecisionSource = {
      decide: async (request) => ({
        answers: { operation: answerFor(request, "operation", "DONE", 0.2) },
        model: "jev-test",
        latencyMs: 1,
      }),
    };
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions });

    const result = await runner.run(
      {
        goal: "Reach Welcome",
        browserId: BROWSER_ID,
        verify: [{ text: "Welcome" }],
        minConfidence: 0.5,
      },
      CONTEXT,
    );

    expect(result.status).toBe("passed");
    expect(broker.calls.at(-1)?.command.command).toBe("wait");
  });

  it("resolves a value slot from the local environment without sending its value", async () => {
    const broker = new GoalBroker();
    const decisions = new ScriptedDecisions(["FILL", "BLOCKED"]);
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions });
    process.env.PASEO_JEV_TEST_ACCOUNT = "environment-only-value";

    try {
      await runner.run(
        {
          goal: "Fill the account value slot",
          browserId: BROWSER_ID,
          values: {
            account: { env: "PASEO_JEV_TEST_ACCOUNT", description: "test account" },
          },
          verify: [{ text: "Welcome" }],
        },
        CONTEXT,
      );
    } finally {
      delete process.env.PASEO_JEV_TEST_ACCOUNT;
    }

    expect(broker.filledValue).toBe("environment-only-value");
    expect(JSON.stringify(decisions.requests)).not.toContain("environment-only-value");
  });

  it("does not mutate the page below the confidence threshold", async () => {
    const broker = new GoalBroker();
    const decisions: TypeSafeDecisionSource = {
      decide: async (request) => ({
        answers: {
          operation: answerFor(request, "operation", "CLICK", 0.4),
          click_target: answerFor(request, "click_target", "2"),
        },
        model: "jev-test",
        latencyMs: 5,
      }),
    };
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions });

    const result = await runner.run(
      {
        goal: "Continue",
        browserId: BROWSER_ID,
        verify: [{ text: "Welcome" }],
      },
      CONTEXT,
    );

    expect(result.status).toBe("uncertain");
    expect(broker.calls.map((call) => call.command.command)).toEqual(["snapshot"]);
  });

  it("re-observes after a stale ref without retrying the same mutation", async () => {
    const broker = new GoalBroker();
    broker.staleClicks = true;
    const decisions = new ScriptedDecisions(["CLICK", "BLOCKED"]);
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions });

    const result = await runner.run(
      {
        goal: "Continue",
        browserId: BROWSER_ID,
        verify: [{ text: "Welcome" }],
      },
      CONTEXT,
    );

    expect(result.status).toBe("blocked");
    expect(broker.calls.filter((call) => call.command.command === "click")).toHaveLength(1);
  });
});

describe("JevBrowserGoalRunner activity", () => {
  it("streams phases, the chosen target, and confidence without the filled value", async () => {
    const events: BrowserActivityEvent[] = [];
    const activity = new BrowserActivityHub((event) => events.push(event));
    const runner = new JevBrowserGoalRunner({
      broker: new GoalBroker(),
      decisionSource: new ScriptedDecisions(["FILL", "CLICK", "DONE"]),
      activity,
    });

    await runner.run(
      {
        goal: "Sign in and reach Welcome",
        browserId: BROWSER_ID,
        values: { account: { value: "secret-account", description: "email" } },
        verify: [{ text: "Welcome" }],
      },
      CONTEXT,
    );

    expect(events.map((event) => `${event.step}:${event.phase}`)).toEqual([
      "0:observing",
      "1:observing",
      "1:deciding",
      "1:selected",
      "1:executing",
      "2:observing",
      "2:deciding",
      "2:selected",
      "2:executing",
      "3:observing",
      // The page already shows "Welcome", so the checks pass without asking Jev again.
      "3:verifying",
      "3:finished",
    ]);
    expect(events.every((event) => event.workspaceId === "workspace-1")).toBe(true);
    expect(events.every((event) => event.browserId === BROWSER_ID)).toBe(true);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(events.every((event) => event.kind === "goal" && event.next === undefined)).toBe(true);
    expect(events[3]?.action).toEqual({
      operation: "FILL",
      target: { role: "textbox", name: "Email" },
      valueSlot: "account",
      confidence: 1,
      targetConfidence: 1,
      status: "active",
    });
    expect(events.at(-1)).toMatchObject({
      result: { status: "passed" },
      steps: [
        { operation: "FILL", status: "done" },
        { operation: "CLICK", target: { role: "button", name: "Continue" }, status: "done" },
      ],
    });
    expect(JSON.stringify(events)).not.toContain("secret-account");
  });

  it("pauses on takeover and snapshots the page again before deciding", async () => {
    const log: string[] = [];
    const broker = new GoalBroker();
    const execute = broker.execute.bind(broker);
    broker.execute = async (input) => {
      log.push(input.command.command);
      return execute(input);
    };
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    const activity = new BrowserActivityHub((event) => {
      if (event.phase === "paused") markPaused();
    });
    const decisions = new ScriptedDecisions(["CLICK", "DONE"]);
    const decide = decisions.decide.bind(decisions);
    decisions.decide = async (request) => {
      log.push("decide");
      if (log.filter((entry) => entry === "decide").length === 1) {
        activity.control({ workspaceId: "workspace-1", browserId: BROWSER_ID, action: "pause" });
      }
      return decide(request);
    };
    const runner = new JevBrowserGoalRunner({ broker, decisionSource: decisions, activity });

    const run = runner.run(
      { goal: "Continue", browserId: BROWSER_ID, verify: [{ text: "Welcome" }] },
      CONTEXT,
    );
    await paused;
    expect(log).toEqual(["snapshot", "decide", "click"]);

    broker.clicked = true;
    activity.control({ workspaceId: "workspace-1", browserId: BROWSER_ID, action: "resume" });
    const result = await run;

    expect(result.status).toBe("passed");
    expect(log).toEqual(["snapshot", "decide", "click", "snapshot", "wait"]);
  });

  it("finishes the activity as failed when the run aborts", async () => {
    const events: BrowserActivityEvent[] = [];
    const broker = new GoalBroker();
    const execute = broker.execute.bind(broker);
    broker.execute = async (input) => {
      if (input.command.command === "snapshot" && broker.clicked) {
        throw new Error("Browser tab closed");
      }
      return execute(input);
    };
    const runner = new JevBrowserGoalRunner({
      broker,
      decisionSource: new ScriptedDecisions(["CLICK"]),
      activity: new BrowserActivityHub((event) => events.push(event)),
    });

    await expect(
      runner.run(
        { goal: "Continue", browserId: BROWSER_ID, verify: [{ text: "Welcome" }] },
        CONTEXT,
      ),
    ).rejects.toThrow("Browser tab closed");
    expect(events.at(-1)).toMatchObject({
      phase: "finished",
      result: { status: "failed", message: "Browser tab closed" },
    });
  });
});

describe("parseObservedElements", () => {
  it("accepts daemon and desktop snapshot ref formats", () => {
    expect(
      parseObservedElements(
        '- textbox "Email" @e1\n  - button "Continue" [ref=@e2]\n- heading "Ignored"',
      ),
    ).toEqual([
      { role: "textbox", name: "Email", ref: "@e1" },
      { role: "button", name: "Continue", ref: "@e2" },
    ]);
  });
});

function answerFor(
  request: TypeSafeDecisionRequest,
  questionName: string,
  choice: string,
  confidence = 1,
): TypeSafeChoiceAnswer {
  const choices = Object.keys(request.questions[questionName]?.criteria ?? {});
  if (!choices.includes(choice)) {
    throw new Error(`Choice ${choice} is not available for ${questionName}: ${choices.join(",")}`);
  }
  return {
    choice,
    confidence,
    probabilities: Object.fromEntries(choices.map((entry) => [entry, entry === choice ? 1 : 0])),
  };
}

function snapshotPayload(snapshot: string): BrowserToolsResponsePayload {
  return success({
    command: "snapshot",
    browserId: BROWSER_ID,
    workspaceId: "workspace-1",
    url: "https://example.com/login",
    title: "Example",
    format: "aria-yaml",
    snapshot,
    truncated: false,
    stats: { nodeCount: 2, refCount: 2, textLength: snapshot.length },
  });
}

function success(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): BrowserToolsResponsePayload {
  return { requestId: "request-1", ok: true, result };
}
