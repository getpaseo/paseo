import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import {
  cleanupReadOnlyCodexTemp,
  prepareReadOnlyCodexRuntime,
  removeReadOnlyCodexState,
} from "./codex/read-only.js";

test.skipIf(process.platform !== "darwin")(
  "a live descendant cannot mutate a quarantined directory through its old cwd",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-quarantine-boundary-")));
    const cwd = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(cwd);
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      const runtime = await prepareReadOnlyCodexRuntime({
        agentId: "owner",
        cwd,
        stateRoot,
        env: { ...process.env, CODEX_HOME: cwd },
      });
      child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          runtime.profile,
          process.execPath,
          "-e",
          "const fs=require('fs');process.chdir(process.env.TMPDIR);console.log('ready');process.stdin.once('data',()=>{let error=null;try{fs.writeFileSync('escape','changed');}catch(e){error=e.code;}console.log(JSON.stringify({error}));});",
        ],
        { cwd, env: runtime.env, stdio: "pipe" },
      );
      exited = once(child, "exit");
      const lines = createInterface({ input: child.stdout });
      const output = lines[Symbol.asyncIterator]();
      expect(await output.next()).toMatchObject({ value: "ready", done: false });
      const quarantine = join(stateRoot, ".cleanup-fixture");
      await mkdir(quarantine);
      const removed = join(quarantine, "removed");
      await rename(runtime.env.TMPDIR!, removed);
      child.stdin.end("continue");
      expect(await output.next()).toMatchObject({ value: '{"error":"EPERM"}', done: false });
      await exited;
      lines.close();
      expect(await readdir(removed)).toEqual([]);
    } finally {
      child?.kill();
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  { operation: cleanupReadOnlyCodexTemp, remaining: ["neighbor", "owner"] },
  { operation: removeReadOnlyCodexState, remaining: ["neighbor"] },
])(
  "$operation.name preserves neighbors and symlink targets without quarantine leaks",
  async ({ operation, remaining }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-cleanup-scope-")));
    const stateRoot = join(root, "state");
    const external = join(root, "external");
    await mkdir(join(stateRoot, "owner"), { recursive: true });
    await mkdir(join(stateRoot, "neighbor"));
    await mkdir(external);
    await writeFile(join(external, "keep"), "external");
    await writeFile(join(stateRoot, "neighbor", "keep"), "neighbor");
    await symlink(external, join(stateRoot, "owner", "tmp"));
    try {
      await operation("owner", stateRoot);
      expect(await readFile(join(external, "keep"), "utf8")).toBe("external");
      expect(await readFile(join(stateRoot, "neighbor", "keep"), "utf8")).toBe("neighbor");
      expect((await readdir(stateRoot)).sort()).toEqual(remaining);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "provider cannot replace its state root to redirect daemon cleanup",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-state-root-")));
    const cwd = join(root, "workspace");
    const stateRoot = join(root, "state");
    const external = join(root, "external");
    await mkdir(cwd);
    await mkdir(join(external, "tmp"), { recursive: true });
    const sentinel = join(external, "tmp", "keep");
    await writeFile(sentinel, "original");
    try {
      const runtime = await prepareReadOnlyCodexRuntime({
        agentId: "owner",
        cwd,
        stateRoot,
        env: { ...process.env, CODEX_HOME: cwd },
      });
      const child = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          runtime.profile,
          process.execPath,
          "-e",
          "const fs=require('fs');let error=null;try{fs.rmSync(process.env.CODEX_HOME,{recursive:true});fs.symlinkSync(" +
            JSON.stringify(external) +
            ",process.env.CODEX_HOME);}catch(e){error=e.code;}console.log(JSON.stringify({error}));",
        ],
        { env: runtime.env, cwd, encoding: "utf8", timeout: 5000 },
      );
      expect(child.status).toBe(0);
      await cleanupReadOnlyCodexTemp("owner", stateRoot);
      expect(await readFile(sentinel, "utf8")).toBe("original");
      expect(JSON.parse(child.stdout)).toEqual({ error: "EPERM" });
      await removeReadOnlyCodexState("owner", stateRoot);
      await expect(access(runtime.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sentinel, "utf8")).toBe("original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  { ancestor: "owner", operation: cleanupReadOnlyCodexTemp },
  { ancestor: "owner", operation: removeReadOnlyCodexState },
  { ancestor: "root", operation: cleanupReadOnlyCodexTemp },
  { ancestor: "root", operation: removeReadOnlyCodexState },
])(
  "cleanup refuses a symlinked $ancestor ancestor ($operation.name)",
  async ({ ancestor, operation }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-state-cleanup-")));
    const stateRoot = join(root, "state");
    const external = join(root, "external");
    const target = ancestor === "owner" ? external : join(external, "owner");
    await mkdir(join(target, "tmp"), { recursive: true });
    const sentinel = join(target, "tmp", "keep");
    await writeFile(sentinel, "original");
    if (ancestor === "owner") {
      await mkdir(stateRoot);
      await symlink(external, join(stateRoot, "owner"));
    } else await symlink(external, stateRoot);
    try {
      await expect(operation("owner", stateRoot)).rejects.toThrow("Unsafe read-only state");
      expect(await readFile(sentinel, "utf8")).toBe("original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
        "import {appendFileSync,readFileSync,realpathSync,writeFileSync,linkSync,symlinkSync} from 'node:fs';",
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
        "const homeResolved=realpathSync(process.env.CODEX_HOME);",
        "const ownState=readFileSync(process.env.CODEX_HOME+'/clean-state','utf8');",
        "let neighborError=null;try{readFileSync(process.env.CODEX_HOME+'/../another-agent/secret')}catch(error){neighborError=error.code;}",
        "writeFileSync(" +
          JSON.stringify(report) +
          ",JSON.stringify({input,writeError,links,loopback,configError,secretError,homeResolved,ownState,neighborError,paseoToken:process.env.PASEO_AUTH_TOKEN??null,childExit:child.status,home:process.env.CODEX_HOME}));",
        "createInterface({input:process.stdin}).on('line',line=>{",
        " const request=JSON.parse(line); if(request.id===undefined)return;",
        " appendFileSync(" + JSON.stringify(requests) + ", JSON.stringify(request)+'\\n');",
        " const result=request.method==='config/read'?{config:{mcp_servers:{inherited_writer:{command:'/bin/echo'}}}}:request.method==='initialize'?{userAgent:'fixture'}:request.method==='thread/start'?{thread:{id:'thread-1'}}:request.method==='turn/start'?{turn:{id:'turn-1',status:'inProgress'}}:{data:[]};",
        " process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');",
        "});",
      ].join("\n"),
    );
    await writeFile(join(state, "clean-state"), "owner");
    await mkdir(join(stateRoot, "another-agent"));
    await writeFile(join(stateRoot, "another-agent", "secret"), "neighbor");
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
        homeResolved: state,
        ownState: "owner",
        neighborError: "EPERM",
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
