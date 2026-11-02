import { setImmediate as waitForCommandContinuations } from "node:timers/promises";
import { Command } from "commander";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { createAllowCommand, type PermitClient } from "./allow.js";
import { createDenyCommand } from "./deny.js";

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";
const requests: AgentPermissionRequest[] = [
  {
    id: "permission-write",
    provider: "codex",
    name: "CodexBash",
    kind: "tool",
  },
  { id: "permission-edit", provider: "codex", name: "CodexBash", kind: "tool" },
];

class PermissionClient implements PermitClient {
  readonly pending = [...requests];
  readonly responses = new Map<string, AgentPermissionResponse>();
  closed = false;
  private notifyReceived = () => {};
  private readonly confirmations = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();

  async fetchAgent() {
    return { agent: { id: agentId, pendingPermissions: this.pending } };
  }

  async respondToPermission(
    _agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) {
    this.responses.set(requestId, response);
    this.notifyReceived();
  }

  async respondToPermissionAndWait(
    responseAgentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const confirmation = new Promise<void>((resolve, reject) => {
      this.confirmations.set(requestId, { resolve, reject });
    });
    await this.respondToPermission(responseAgentId, requestId, response);
    await confirmation;
  }

  async close() {
    this.closed = true;
  }

  async waitForResponses(count: number) {
    while (this.responses.size < count) {
      await new Promise<void>((resolve) => {
        this.notifyReceived = resolve;
      });
    }
  }

  confirm(requestId: string) {
    const confirmation = this.confirmations.get(requestId);
    if (!confirmation) throw new Error(`No confirmation waiter: ${requestId}`);
    this.pending.splice(
      this.pending.findIndex((request) => request.id === requestId),
      1,
    );
    confirmation.resolve();
  }

  fail(requestId: string, error: Error) {
    const confirmation = this.confirmations.get(requestId);
    if (!confirmation) throw new Error(`No confirmation waiter: ${requestId}`);
    confirmation.reject(error);
  }
}

const options = {
  daemonTarget: { kind: "endpoint" as const, host: "test.invalid" },
};
const actions = [
  { name: "allow", create: createAllowCommand, result: "allowed" },
  { name: "deny", create: createDenyCommand, result: "denied" },
];
for (const action of actions) {
  describe(`permit ${action.name}`, () => {
    it("returns success and closes only after confirmation", async () => {
      const client = new PermissionClient();
      let completed = false;
      const command = action.create(async () => client)(
        agentId,
        requests[0].id,
        options,
        new Command(),
      );
      void command.then(
        () => (completed = true),
        () => false,
      );
      await client.waitForResponses(1);
      await waitForCommandContinuations();
      expect(completed).toBe(false);
      expect(client.closed).toBe(false);
      expect(client.pending).toEqual(requests);
      client.confirm(requests[0].id);
      const result = await command;
      expect(result.data).toEqual([
        {
          requestId: requests[0].id,
          agentId,
          agentShortId: agentId.slice(0, 7),
          name: "CodexBash",
          result: action.result,
        },
      ]);
      expect(client.closed).toBe(true);
      expect(client.pending).toEqual([requests[1]]);
    });

    it("waits for every confirmation with --all", async () => {
      const client = new PermissionClient();
      let completed = false;
      const command = action.create(async () => client)(
        agentId,
        undefined,
        { ...options, all: true },
        new Command(),
      );
      void command.then(
        () => (completed = true),
        () => false,
      );
      await client.waitForResponses(2);
      client.confirm(requests[0].id);
      // Wait beyond the first reply's promise continuations while withholding the second.
      await waitForCommandContinuations();
      expect(completed).toBe(false);
      expect(client.closed).toBe(false);
      client.confirm(requests[1].id);
      const result = await command;
      expect(result.data.map((item) => item.result)).toEqual([action.result, action.result]);
      expect(client.closed).toBe(true);
      expect(client.pending).toEqual([]);
    });

    it("rejects an unconfirmed response without returning success", async () => {
      const client = new PermissionClient();
      const command = action.create(async () => client)(
        agentId,
        requests[0].id,
        options,
        new Command(),
      );
      const failure = expect(command).rejects.toMatchObject({
        code: "PERMISSION_RESPONSE_UNCONFIRMED",
        message: expect.stringContaining(requests[0].id),
        details: 'Use "paseo permit ls" to check whether the request is still pending',
      });
      await client.waitForResponses(1);
      client.fail(requests[0].id, new Error("Timeout waiting for message (15000ms)"));
      await failure;
      expect(client.closed).toBe(true);
      expect(client.pending).toEqual(requests);
    });
  });
}
