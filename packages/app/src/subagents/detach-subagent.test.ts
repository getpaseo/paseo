import { describe, expect, it } from "vitest";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import {
  requestDetachSubagent,
  resolveDetachSubagentDialog,
  type DetachSubagentDeps,
  type ResolveDetachSubagentDialogInput,
} from "./detach-subagent";

interface RecordedDetach {
  serverId: string;
  agentId: string;
}

interface RecordedOpen {
  serverId: string;
  agentId: string;
}

interface FakeDetachSubagentEnv {
  deps: DetachSubagentDeps;
  recordedDetaches: RecordedDetach[];
  recordedOpens: RecordedOpen[];
  recordedConfirmInputs: ConfirmDialogInput[];
  recordedErrors: unknown[];
}

function createFakeEnv(
  options: {
    confirmResult?: boolean;
    initialSubagents?: Array<{ id: string; snapshot: ResolveDetachSubagentDialogInput }>;
  } = {},
): FakeDetachSubagentEnv {
  const subagents = new Map<string, ResolveDetachSubagentDialogInput | undefined>();
  for (const entry of options.initialSubagents ?? []) {
    subagents.set(entry.id, entry.snapshot);
  }
  const recordedDetaches: RecordedDetach[] = [];
  const recordedOpens: RecordedOpen[] = [];
  const recordedConfirmInputs: ConfirmDialogInput[] = [];
  const recordedErrors: unknown[] = [];

  return {
    recordedDetaches,
    recordedOpens,
    recordedConfirmInputs,
    recordedErrors,
    deps: {
      getSubagent: (id) => subagents.get(id),
      confirm: async (dialog) => {
        recordedConfirmInputs.push(dialog);
        return options.confirmResult ?? false;
      },
      detachAgent: async (input) => {
        recordedDetaches.push(input);
      },
      openDetachedAgent: (input) => {
        recordedOpens.push(input);
      },
      reportError: (error) => {
        recordedErrors.push(error);
      },
    },
  };
}

describe("resolveDetachSubagentDialog", () => {
  it("uses non-destructive copy for named subagents", () => {
    expect(resolveDetachSubagentDialog({ title: "Review branch" })).toEqual({
      title: "Detach subagent?",
      message: "Review branch will leave this track and continue as a standalone agent.",
      confirmLabel: "Detach",
      cancelLabel: "Cancel",
      destructive: false,
    });
  });

  it("falls back to this subagent when the title is not displayable", () => {
    expect(resolveDetachSubagentDialog({ title: "New Agent" })).toEqual({
      title: "Detach subagent?",
      message: "This subagent will leave this track and continue as a standalone agent.",
      confirmLabel: "Detach",
      cancelLabel: "Cancel",
      destructive: false,
    });
  });
});

describe("requestDetachSubagent", () => {
  it("detaches the subagent with the server id when the user confirms", async () => {
    const env = createFakeEnv({
      confirmResult: true,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });

    await requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps);

    expect(env.recordedDetaches).toEqual([{ serverId: "server-1", agentId: "child-agent" }]);
  });

  it("opens the detached subagent after detach succeeds", async () => {
    const env = createFakeEnv({
      confirmResult: true,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });

    await requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps);

    expect(env.recordedOpens).toEqual([{ serverId: "server-1", agentId: "child-agent" }]);
  });

  it("does not detach the subagent when the user cancels", async () => {
    const env = createFakeEnv({
      confirmResult: false,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });

    await requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps);

    expect(env.recordedDetaches).toEqual([]);
    expect(env.recordedOpens).toEqual([]);
  });

  it("asks for confirmation using the resolved dialog for the subagent", async () => {
    const env = createFakeEnv({
      confirmResult: false,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });

    await requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps);

    expect(env.recordedConfirmInputs).toEqual([
      resolveDetachSubagentDialog({ title: "Review branch" }),
    ]);
  });

  it("reports detach errors after the user confirms", async () => {
    const env = createFakeEnv({
      confirmResult: true,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });
    const error = new Error("daemon offline");
    env.deps.detachAgent = async () => {
      throw error;
    };

    await expect(
      requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps),
    ).resolves.toBeUndefined();
    expect(env.recordedErrors).toEqual([error]);
    expect(env.recordedOpens).toEqual([]);
  });
});
