import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  DaemonSelfUpdateInProgressError,
  type DaemonSelfUpdateInput,
  type DaemonSelfUpdater,
} from "./daemon-self-updater.js";
import {
  DaemonSelfUpdateSessionController,
  type DaemonSelfUpdateSessionControllerOptions,
} from "./daemon-self-update-session-controller.js";

type TestUpdater = Pick<DaemonSelfUpdater, "update">;
type RestartIntent = Parameters<DaemonSelfUpdateSessionControllerOptions["emitLifecycleIntent"]>[0];

interface ControllerHarness {
  controller: DaemonSelfUpdateSessionController;
  emitted: SessionOutboundMessage[];
  restartIntents: RestartIntent[];
}

function createController(input: {
  updater: TestUpdater;
  daemonVersion?: string | null;
  desktopManaged?: boolean;
}): ControllerHarness {
  const emitted: SessionOutboundMessage[] = [];
  const restartIntents: RestartIntent[] = [];
  const controller = new DaemonSelfUpdateSessionController({
    clientId: "client-1",
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged,
    emit: (msg) => {
      emitted.push(msg);
    },
    emitLifecycleIntent: (intent) => {
      restartIntents.push(intent);
    },
    sessionLogger: createTestLogger(),
    updater: input.updater,
  });

  return { controller, emitted, restartIntents };
}

const updateRequest: SessionInboundMessage = {
  type: "daemon.update.request",
  requestId: "update-1",
};

describe("DaemonSelfUpdateSessionController", () => {
  test("returns undefined synchronously for messages owned by another subsystem", () => {
    const updater: TestUpdater = {
      async update() {
        throw new Error("update should not run");
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });
    const message: SessionInboundMessage = {
      type: "daemon.get_status.request",
      requestId: "status-1",
    };

    const result = controller.dispatch(message);

    expect(result).toBeUndefined();
    expect(emitted).toEqual([]);
    expect(restartIntents).toEqual([]);
  });

  test("emits progress, response, and restart lifecycle intent after a successful update", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        input.onProgress("starting");
        input.onProgress("installing");
        return { success: true, error: null, newVersion: "0.1.96" };
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(updateInput?.daemonVersion).toBe("0.1.15");
    expect(updateInput?.desktopManaged).toBe(false);
    expect(emitted).toEqual([
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "starting",
        },
      },
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "installing",
        },
      },
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: true,
          error: null,
          previousVersion: "0.1.15",
          newVersion: "0.1.96",
        },
      },
    ]);
    expect(restartIntents).toEqual([
      {
        type: "restart",
        clientId: "client-1",
        requestId: "update-1",
        reason: "daemon_update",
      },
    ]);
  });

  test("emits a failed response without restart lifecycle intent", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        return { success: false, error: "not an npm global install", newVersion: null };
      },
    };
    const { controller, emitted, restartIntents } = createController({
      updater,
      desktopManaged: true,
    });

    await controller.dispatch(updateRequest);

    expect(updateInput?.desktopManaged).toBe(true);
    expect(emitted).toEqual([
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: false,
          error: "not an npm global install",
          previousVersion: "0.1.15",
          newVersion: null,
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });

  test("maps concurrent updates to rpc_error", async () => {
    const updater: TestUpdater = {
      async update() {
        throw new DaemonSelfUpdateInProgressError();
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "update-1",
          requestType: "daemon.update.request",
          error: "An update is already in progress",
          code: "already_updating",
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });
});
