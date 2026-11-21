// Injected CLI adapter using the real ACP SDK/stdio. An independent loopback
// driver controls barriers without accessing the Paseo session connection.
import { Readable } from "node:stream";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
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
const controlReady = Promise.withResolvers();
const replySent = Promise.withResolvers();
let connection;
let outputBuffer = "";
const output = new WritableStream({
  async write(chunk) {
    await new Promise((resolve, reject) =>
      process.stdout.write(chunk, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    outputBuffer += Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = outputBuffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(outputBuffer.slice(0, newline));
      outputBuffer = outputBuffer.slice(newline + 1);
      if (message.result?.outcome === "injected" || message.error?.message === "steering failed")
        replySent.resolve();
    }
  },
});
const record = (method, params) => state.calls.push({ method, params });

const agentConnection = new AgentSideConnection(
  (client) => {
    connection = client;
    return {
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
        await controlReady.promise;
        record("session/new", params);
        return { sessionId: "session-1" };
      },
      async loadSession(params) {
        await controlReady.promise;
        record("session/load", params);
        return {};
      },
      async unstable_resumeSession(params) {
        await controlReady.promise;
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
        throw RequestError.methodNotFound(method);
      },
    };
  },
  ndJsonStream(output, Readable.toWeb(process.stdin)),
);

const control = connect(options.controlPort, "127.0.0.1");
await once(control, "connect");
controlReady.resolve();
const commands = createInterface({ input: control });
commands.on("line", (line) => {
  const { id, method } = JSON.parse(line);
  // Concurrent handlers let release/ack commands unblock pending barriers.
  void handleControl(method).then(() => control.write(`${JSON.stringify({ id, state })}\n`));
});
async function handleControl(method) {
  if (method === "prompt-started") {
    await promptStarted.promise;
    return {};
  }
  if (method === "steering-started") {
    await steeringStarted.promise;
    return {};
  }
  if (method === "ack-steer") {
    releaseReceipt.resolve();
    return {};
  }
  if (method === "release") {
    releasePrompt.resolve();
    return {};
  }
  if (method === "state") return state;
  if (method === "permissions") {
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
  if (method === "permission-results") {
    await Promise.all(permissions);
    return state;
  }

  if (method === "reply-sent") {
    await replySent.promise;
    // Inventory follows the late reply on the same ordered ACP stream. Its
    // public listCommands result is a client-side receipt barrier.
    await connection.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "reply-observed", description: "Steering reply barrier" }],
      },
    });
    return;
  }
  if (method === "disconnect") {
    process.stdout.end();
    process.stdin.destroy();
    return;
  }
  throw new Error(`Unknown control command: ${method}`);
}
await agentConnection.closed;
