// Independent ACP peer for steering tests. Control methods are explicit synchronization
// barriers so the prompt stays pending while extension requests are handled concurrently.
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const options = JSON.parse(process.argv[2]);
const state = { calls: [], order: [], permissionResults: [] };
const promptStarted = Promise.withResolvers();
const releasePrompt = Promise.withResolvers();
const steeringStarted = Promise.withResolvers();
const releaseReceipt = Promise.withResolvers();
const permissions = [];
const record = (method, params) => state.calls.push({ method, params });

const agentConnection = new AgentSideConnection(
  (connection) => ({
    async initialize(params) {
      record("initialize", params);
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities:
          options.resume === "resume"
            ? { sessionCapabilities: { resume: {} } }
            : { loadSession: true },
        ...(options.initialize ?? { _meta: { steering: { supported: true } } }),
      };
    },
    async authenticate() {},
    async newSession(params) {
      record("session/new", params);
      return { sessionId: "session-1" };
    },
    async loadSession(params) {
      record("session/load", params);
      return {};
    },
    async unstable_resumeSession(params) {
      record("session/resume", params);
      return {};
    },
    async prompt(params) {
      record("session/prompt", params);
      promptStarted.resolve();
      await releasePrompt.promise;
      return { stopReason: "end_turn" };
    },
    async cancel(params) {
      record("session/cancel", params);
      releasePrompt.resolve();
    },
    async extMethod(method, params) {
      if (method === "_session/steering") {
        record(method, params);
        steeringStarted.resolve();
        if (options.holdReceipt) await releaseReceipt.promise;
        if (options.rpcError) throw new RequestError(-32000, "steering failed");
        const receipt = Object.hasOwn(options, "receipt")
          ? options.receipt
          : { outcome: "injected" };
        if (receipt?.outcome === "injected") state.order.push("injected");
        return receipt;
      }
      if (method === "_test/prompt-started") {
        await promptStarted.promise;
        return {};
      }
      if (method === "_test/steering-started") {
        await steeringStarted.promise;
        return {};
      }
      if (method === "_test/ack-steer") {
        releaseReceipt.resolve();
        return {};
      }
      if (method === "_test/release") {
        releasePrompt.resolve();
        return {};
      }
      if (method === "_test/state") return state;
      if (method === "_test/permissions") {
        for (const id of ["one", "two"]) {
          permissions.push(
            connection
              .requestPermission({
                sessionId: "session-1",
                toolCall: { toolCallId: id, title: id, kind: "execute", status: "pending" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              })
              .then((result) => {
                state.order.push(result.outcome.optionId ?? result.outcome.outcome);
                state.permissionResults.push(result);
                return result;
              }),
          );
        }
        return {};
      }
      if (method === "_test/permission-results") {
        await Promise.all(permissions);
        return state;
      }
      throw RequestError.methodNotFound(method);
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

await agentConnection.closed;
