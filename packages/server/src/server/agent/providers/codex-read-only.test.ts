import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";

test.each([
  { name: "unexamined page", status: { data: [], nextCursor: "more" } },
  { name: "enabled server", status: { data: [{ runtimeStatus: "ready", tools: {} }] } },
  { name: "exposed tool", status: { data: [{ runtimeStatus: "disabled", tools: { write: {} } }] } },
])("read-only rejects an MCP catalog with $name", async ({ status }) => {
  const server = createFakeCodexAppServer({ "mcpServerStatus/list": () => status });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/fixture", writePolicy: "read_only", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => server.child,
  );
  try {
    await expect(session.startTurn("fixture only")).rejects.toThrow("MCP servers to be disabled");
    expect(server.requests().some((request) => request.method === "turn/start")).toBe(false);
  } finally {
    await session.close();
  }
});

test("read-only checks MCP servers even when the resumed thread is already loaded", async () => {
  const server = createFakeCodexAppServer({
    "thread/loaded/list": () => ({ data: ["thread-1"] }),
    "mcpServerStatus/list": () => ({ data: [{ runtimeStatus: "ready", tools: {} }] }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/fixture", writePolicy: "read_only", model: "gpt-5.4" },
    { sessionId: "thread-1" },
    createTestLogger(),
    async () => server.child,
  );
  try {
    await expect(session.connect()).rejects.toThrow("MCP servers to be disabled");
  } finally {
    await session.close();
  }
});

test.skipIf(process.platform !== "darwin")(
  "read-only confines the provider and descendants while keeping private state writable",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-codex-readonly-")));
    const paseoHome = join(root, "paseo");
    const stateRoot = join(paseoHome, "codex-read-only");
    vi.stubEnv("PASEO_HOME", paseoHome);
    const agentId = "54ef6e38-90da-4e24-bd53-d4f7d1ae9eaf";
    const state = join(stateRoot, agentId);
    const cwd = join(root, "workspace");
    const fixture = join(cwd, "input");
    const report = join(state, "probe.json");
    const requests = join(state, "requests.jsonl");
    const script = join(root, "provider.mjs");
    await mkdir(state, { recursive: true });
    const secret = join(paseoHome, "daemon-secret");
    await writeFile(secret, "fixture-only");
    await mkdir(cwd);
    await writeFile(fixture, "original");
    const listener = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await writeFile(
      script,
      [
        "import {appendFileSync,readFileSync,writeFileSync,linkSync,symlinkSync} from 'node:fs';",
        "import {connect} from 'node:net';",
        "import {spawnSync} from 'node:child_process';",
        "import {createInterface} from 'node:readline';",
        "const fixture=" + JSON.stringify(fixture) + ";",
        "const input=readFileSync(fixture,'utf8');",
        "let writeError=null; try {writeFileSync(fixture,'parent-write');} catch(error) {writeError=error.code;}",
        "const child=spawnSync('/bin/sh',['-c','printf child-write > \"'+fixture+'\"']);",
        "const links={}; for(const [name,link] of [['hardlink',linkSync],['symlink',symlinkSync]]) {try{const target=process.env.CODEX_HOME+'/'+name;link(fixture,target);writeFileSync(target,'link-write');links[name]='written';}catch(error){links[name]=error.code;}}",
        "const loopback=await new Promise(resolve=>{const socket=connect(" +
          address.port +
          ",'127.0.0.1');socket.once('error',error=>resolve(error.code));socket.once('connect',()=>{socket.destroy();resolve('connected');});});",
        "let configError=null;try{writeFileSync(process.env.CODEX_HOME+'/config.toml','mcp_servers={}') }catch(error){configError=error.code;}",
        "let secretError=null;try{readFileSync(" +
          JSON.stringify(secret) +
          ")}catch(error){secretError=error.code;}",
        "writeFileSync(" +
          JSON.stringify(report) +
          ",JSON.stringify({input,writeError,links,loopback,configError,secretError,paseoToken:process.env.PASEO_AUTH_TOKEN??null,childExit:child.status,home:process.env.CODEX_HOME}));",
        "createInterface({input:process.stdin}).on('line',line=>{",
        " const request=JSON.parse(line); if(request.id===undefined)return;",
        " appendFileSync(" + JSON.stringify(requests) + ", JSON.stringify(request)+'\\n');",
        " const result=request.method==='config/read'?{config:{mcp_servers:{inherited_writer:{command:'/bin/echo'}}}}:request.method==='initialize'?{userAgent:'fixture'}:request.method==='thread/start'?{thread:{id:'thread-1'}}:request.method==='turn/start'?{turn:{id:'turn-1',status:'inProgress'}}:{data:[]};",
        " process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');",
        "});",
      ].join("\n"),
    );
    const client = new CodexAppServerAgentClient(
      createTestLogger(),
      {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { CODEX_HOME: state, PASEO_AUTH_TOKEN: "fixture-only" },
      },
      { readOnlyStateRoot: stateRoot },
    );
    let session;
    try {
      session = await client.createSession(
        {
          provider: "codex",
          cwd,
          model: "gpt-5",
          thinkingOptionId: "medium",
          writePolicy: "read_only",
          mcpServers: { supplied_writer: { type: "stdio", command: "/bin/echo" } },
        },
        { agentId },
      );
      await session.startTurn("Local fixture only");
      await session.close();
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
        input: "original",
        writeError: "EPERM",
        childExit: 1,
        home: state,
        links: { hardlink: "EPERM", symlink: "EPERM" },
        loopback: "EPERM",
        configError: "EPERM",
        secretError: "EPERM",
        paseoToken: null,
      });
      expect(await readFile(fixture, "utf8")).toBe("original");
      const calls = (await readFile(requests, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.find((call) => call.method === "thread/start").params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
          mcp_servers: {
            inherited_writer: { enabled: false },
            supplied_writer: { enabled: false },
          },
        },
      });
      expect(calls.find((call) => call.method === "turn/start").params).toMatchObject({
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    } finally {
      await session?.close();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
