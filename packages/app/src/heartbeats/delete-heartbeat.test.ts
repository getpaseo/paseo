import { describe, expect, it } from "vitest";
import { resolveDeleteScheduleDialog } from "@/schedules/delete-schedule";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import { requestDeleteHeartbeat, type DeleteHeartbeatDeps } from "./delete-heartbeat";

interface RecordedDelete {
  serverId: string;
  scheduleId: string;
}

interface FakeDeleteHeartbeatEnv {
  deps: DeleteHeartbeatDeps;
  recordedDeletes: RecordedDelete[];
  recordedConfirmInputs: ConfirmDialogInput[];
  recordedErrors: unknown[];
}

function createFakeEnv(options: { confirmResult?: boolean } = {}): FakeDeleteHeartbeatEnv {
  const recordedDeletes: RecordedDelete[] = [];
  const recordedConfirmInputs: ConfirmDialogInput[] = [];
  const recordedErrors: unknown[] = [];

  return {
    recordedDeletes,
    recordedConfirmInputs,
    recordedErrors,
    deps: {
      confirm: async (dialog) => {
        recordedConfirmInputs.push(dialog);
        return options.confirmResult ?? false;
      },
      deleteHeartbeat: async (input) => {
        recordedDeletes.push(input);
      },
      reportError: (error) => {
        recordedErrors.push(error);
      },
    },
  };
}

const ROW = { serverId: "host-1", scheduleId: "schedule-1", title: "Watch the build" };

describe("requestDeleteHeartbeat", () => {
  it("asks for destructive confirmation naming the heartbeat", async () => {
    const env = createFakeEnv({ confirmResult: false });

    await requestDeleteHeartbeat(ROW, env.deps);

    expect(env.recordedConfirmInputs).toEqual([
      resolveDeleteScheduleDialog({ productName: "Heartbeat", title: "Watch the build" }),
    ]);
    expect(env.recordedConfirmInputs[0]?.destructive).toBe(true);
  });

  it("deletes the heartbeat on its own host when the user confirms", async () => {
    const env = createFakeEnv({ confirmResult: true });

    await requestDeleteHeartbeat(ROW, env.deps);

    expect(env.recordedDeletes).toEqual([{ serverId: "host-1", scheduleId: "schedule-1" }]);
  });

  it("keeps the heartbeat when the user cancels", async () => {
    const env = createFakeEnv({ confirmResult: false });

    await requestDeleteHeartbeat(ROW, env.deps);

    expect(env.recordedDeletes).toEqual([]);
  });

  it("reports a rejected deletion instead of throwing", async () => {
    const env = createFakeEnv({ confirmResult: true });
    const error = new Error("daemon offline");
    env.deps.deleteHeartbeat = async () => {
      throw error;
    };

    await expect(requestDeleteHeartbeat(ROW, env.deps)).resolves.toBeUndefined();
    expect(env.recordedErrors).toEqual([error]);
  });
});
