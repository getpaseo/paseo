import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
const serverBase =
  process.env.PASEO_MEMORY_SERVER_BASE ??
  "file:///Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/";
const require = createRequire(serverBase + "bootstrap.js");
const pino = require("pino");
const { createPaseoDaemon } = await import(serverBase + "bootstrap.js");
const { BuiltinPluginLoader } = await import(serverBase + "plugins/builtin/index.js");
const { PluginAgentClientRegistry } = await import(serverBase + "agent/plugin-provider.js");
import { fork } from "node:child_process";
import { createWriteStream } from "node:fs";
const out = process.env.PASEO_MEMORY_OUT ?? join(tmpdir(), "paseo-memory-run-" + process.pid);
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "paseo-memory-daemon-"));
const staticDir = join(home, "static");
mkdirSync(staticDir);
const logger = pino(
  { level: "info" },
  pino.destination({ dest: out + "/daemon.log", sync: false }),
);
const plugins = new PluginAgentClientRegistry(logger);
let emit,
  opens = 0;
const sessions = [];
plugins.replace([
  {
    id: "claude",
    label: "Synthetic plugin",
    async connect() {
      let listener;
      const capabilities = ["prompt.message", "session.persistence"];
      return {
        version: 1,
        capabilities,
        onEvent(cb) {
          listener = cb;
          emit = (e) => listener(JSON.parse(JSON.stringify(e)));
          return () => {
            listener = null;
          };
        },
        async close() {},
        async send(input) {
          if (input.type === "session.open") {
            opens++;
            sessions.push(input.sessionId);
            listener({
              type: "session.opened",
              sessionId: input.sessionId,
              requestId: input.requestId,
              cwd: home,
              capabilities,
              restoration: "core",
              persistence: { version: 1, data: { sessionId: input.sessionId } },
            });
            listener({
              type: "session.ready",
              sessionId: input.sessionId,
              requestId: input.requestId,
            });
          } else if (input.type === "catalog")
            listener({
              type: "catalog",
              requestId: input.requestId,
              catalog: { models: [], modes: [], thinkingOptions: [] },
            });
          else if (input.type === "session.close") {
            listener({ type: "session.closed", sessionId: input.sessionId });
            listener({ type: "request.completed", requestId: input.requestId });
          }
        },
      };
    },
  },
]);
const config = {
  listen: "127.0.0.1:0",
  paseoHome: home,
  corsAllowedOrigins: [],
  hostnames: true,
  mcpEnabled: false,
  staticDir,
  mcpDebug: false,
  agentClients: plugins.clients(),
  agentStoragePath: join(home, "agents"),
  relayEnabled: false,
  relayEndpoint: "relay.paseo.sh:443",
  appBaseUrl: "https://app.paseo.sh",
};
const create = () =>
  createPaseoDaemon(config, logger, { builtinPlugins: new BuiltinPluginLoader(undefined, []) });
let daemon = await create();
await daemon.start();
let agents = [];
let clients = [];
const clientsWorker = fork(fileURLToPath(new URL("./clients.mjs", import.meta.url)), [], {
  execPath: process.execPath,
  execArgv: ["--import", "tsx"],
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
clientsWorker.stderr.pipe(createWriteStream(out + "/clients.log"));
const requests = new Map();
let requestSeq = 0;
clientsWorker.on("message", (m) => {
  const pendingRequest = requests.get(m.requestId);
  if (!pendingRequest) return;
  requests.delete(m.requestId);
  if (m.error) pendingRequest.reject(new Error(m.error));
  else pendingRequest.resolve(m.result);
});
clientsWorker.on("exit", (code, signal) => {
  for (const r of requests.values())
    r.reject(new Error("Clients worker exited " + code + " " + signal));
  requests.clear();
});
function request(command) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestSeq;
    requests.set(requestId, { resolve, reject });
    clientsWorker.send({ ...command, requestId });
  });
}

const started = Date.now();
const duration = Number(process.env.PASEO_MEMORY_SECONDS ?? 0);
const stepCount = duration ? 12 : 2;
let loadStarted;
function sample(stage, snapshot = false) {
  global.gc();
  const m = process.memoryUsage();
  const rec = {
    stage,
    pid: process.pid,
    clientsPid: clientsWorker.pid,
    seconds: (Date.now() - started) / 1000,
    loadSeconds: loadStarted ? (Date.now() - loadStarted) / 1000 : null,
    heapMiB: m.heapUsed / 1048576,
    rssMiB: m.rss / 1048576,
    opens,
    agents: daemon.agentManager.listAgents().length,
    items: daemon.agentManager.getRuntimeMetrics?.(),
    home,
  };
  console.log(JSON.stringify(rec));
  appendFileSync(out + "/samples.jsonl", JSON.stringify(rec) + "\n");
  if (snapshot) writeHeapSnapshot(out + "/" + stage + ".heapsnapshot");
}
async function client(n) {
  const port = daemon.getListenTarget().port;
  await request({
    op: "connect",
    index: n,
    url: `ws://127.0.0.1:${port}/ws`,
    agents: agents.map((a) => a.id),
  });
  return {
    subscribeAgentTimeline() {},
    close: () => request({ op: "close", index: n }),
    fetchAgentTimeline: (agentId) => request({ op: "fetch", index: n, agentId }),
  };
}
try {
  sample("startup", true);
  for (let i = 0; i < 3; i++)
    agents.push({
      id: (await daemon.agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {}))
        .id,
    });
  for (let i = 0; i < 15; i++) clients.push(await client(i));
  for (const c of clients) for (const a of agents) c.subscribeAgentTimeline(a.id, () => {});
  await delay(200);
  sample("connected", true);
  loadStarted = Date.now();
  for (let step = 0; step < stepCount; step++) {
    for (let chunk = 1; chunk <= 1000; chunk++) {
      for (let n = 0; n < 3; n++)
        emit({
          type: "timeline.item",
          sessionId: sessions[n],
          item: {
            type: "reasoning",
            id: "reason-" + step,
            text: `${n}:${step}:` + "推理".repeat(15000).slice(0, chunk * 30),
          },
        });
      if (duration)
        await delay(
          Math.max(0, loadStarted + ((step * 1000 + chunk) * duration) / stepCount - Date.now()),
        );
      else if (chunk % 50 === 0) await delay(0);
    }
    for (let n = 0; n < 3; n++)
      emit({
        type: "timeline.item",
        sessionId: sessions[n],
        item: {
          type: "tool_call",
          id: "tool-" + step,
          callId: "tool-" + step,
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: "输出".repeat(16000) },
        },
      });
    await delay(100);
    sample("step-" + (step + 1), duration && (step + 1) % 3 === 0);
    if (duration) {
      await clients[0].close();
      clients[0] = await client(0);
      for (const a of agents) await clients[0].fetchAgentTimeline(a.id, { limit: 200 });
    }
  }
  sample("loaded", true);
  for (let cycle = 0; cycle < 20; cycle++) {
    await clients[0].close();
    clients[0] = await client(0);
    for (const a of agents) await clients[0].fetchAgentTimeline(a.id, { limit: 200 });
  }
  await delay(500);
  sample("reconnected", true);
  for (const c of clients) await c.close();
  clients = [];
  await delay(1500);
  sample("idle");
  for (const a of agents) await daemon.agentManager.archiveAgent(a.id);
  sample("archived", true);
  await daemon.stop();
  const opensBefore = opens;
  daemon = await create();
  await daemon.start();
  sample("restarted-archived", true);
  if (opens !== opensBefore) throw new Error("Archived provider sessions reopened at startup");
  for (const a of agents) {
    await daemon.agentManager.deleteAgentState(a.id);
    await daemon.agentStorage.remove(a.id);
  }
  sample("deleted", true);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  await daemon.stop();
  await plugins.shutdown();
  await request({ op: "shutdown" }).catch(() => {});
  clientsWorker.disconnect();
  logger.flush();
}
