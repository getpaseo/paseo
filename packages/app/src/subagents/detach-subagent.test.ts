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

interface FakeDetachSubagentEnv {
  deps: DetachSubagentDeps;
  recordedDetaches: RecordedDetach[];
  recordedConfirmInputs: ConfirmDialogInput[];
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
  const recordedConfirmInputs: ConfirmDialogInput[] = [];

  return {
    recordedDetaches,
    recordedConfirmInputs,
    deps: {
      getSubagent: (id) => subagents.get(id),
      confirm: async (dialog) => {
        recordedConfirmInputs.push(dialog);
        return options.confirmResult ?? false;
      },
      detachAgent: async (input) => {
        recordedDetaches.push(input);
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
      message: "this subagent will leave this track and continue as a standalone agent.",
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

  it("does not detach the subagent when the user cancels", async () => {
    const env = createFakeEnv({
      confirmResult: false,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });

    await requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps);

    expect(env.recordedDetaches).toEqual([]);
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

  it("swallows detach errors so the caller never sees them", async () => {
    const env = createFakeEnv({
      confirmResult: true,
      initialSubagents: [{ id: "child-agent", snapshot: { title: "Review branch" } }],
    });
    env.deps.detachAgent = async () => {
      throw new Error("daemon offline");
    };

    await expect(
      requestDetachSubagent({ serverId: "server-1", subagentId: "child-agent" }, env.deps),
    ).resolves.toBeUndefined();
  });
});
