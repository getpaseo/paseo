import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import * as privateFiles from "../private-files.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { HostInstructionsRuntime } from "./runtime.js";

it("waits for registration persistence before reporting or using the credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-instruction-registration-"));
  const paseoHome = path.join(root, "source");
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
  const options = {
    paseoHome,
    serverId: "source",
    logger,
    agentManager: new AgentManager({ clients: {}, registry: agentStorage, logger }),
    agentStorage,
    workspaceRegistry: new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "workspaces.json"),
      logger,
    ),
    relay: () => ({
      enabled: false,
      endpoint: "",
      publicEndpoint: "",
      useTls: false,
      publicUseTls: false,
    }),
  };
  let runtime: HostInstructionsRuntime | undefined;
  try {
    const { url } = await generateLocalPairingOffer({
      paseoHome: path.join(root, "destination"),
      relayRequireProtectedSecurity: true,
      includeQr: false,
    });
    if (!url) throw new Error("Expected a protected pairing offer");
    const id = randomUUID();
    const destinationId = "destination";
    const register = {
      action: "register" as const,
      destinationId,
      offer: url,
      token: `${id}.${randomBytes(32).toString("base64url")}`,
    };
    const lookup = { action: "has_registration" as const, destinationId, id };
    runtime = await HostInstructionsRuntime.open(options);
    const write = Promise.withResolvers<void>();
    const persist = vi
      .spyOn(privateFiles, "writePrivateFileAtomic")
      .mockReturnValueOnce(write.promise);
    try {
      // The reads start on the old writer tail, then register publishes its new entry.
      const calls = Promise.allSettled([
        runtime.manage(lookup),
        runtime.submit(destinationId, "agent", "Run the local check", "workspace"),
        runtime.manage(register),
      ]);
      await vi.waitFor(() => expect(persist).toHaveBeenCalled());
      write.reject(new Error("Could not persist registration"));
      expect((await calls).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
      ]);
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      persist.mockRestore();
    }

    await runtime.close();
    runtime = await HostInstructionsRuntime.open(options);
    expect(await runtime.manage(lookup)).toEqual({ hasRegistration: false });
    expect(runtime.outbox.pendingRegistrations()).toEqual([]);
    await runtime.manage(register);
    expect(await runtime.manage(lookup)).toEqual({ hasRegistration: true });
    expect(
      await runtime.submit(destinationId, "agent", "Run the local check", "workspace"),
    ).toMatchObject({ state: "waiting_for_host" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
