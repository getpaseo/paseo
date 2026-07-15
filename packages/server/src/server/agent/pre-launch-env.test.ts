import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEnvOutput, PreLaunchEnvError, resolveAgentEnvVars } from "./pre-launch-env.js";

const PEM = "-----BEGIN KEY-----\nline2=notakey\n-----END KEY-----";

describe("parseEnvOutput", () => {
  it("parses a JSON object", () => {
    expect(parseEnvOutput('{"FOO":"bar","BAZ":"qux"}')).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips non-string JSON values", () => {
    expect(parseEnvOutput('{"A":"1","B":null,"C":2,"D":"keep"}')).toEqual({ A: "1", D: "keep" });
  });

  it("parses NUL-delimited KEY=VALUE records", () => {
    expect(parseEnvOutput("FOO=bar\0BAZ=qux\0")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("parses newline-delimited KEY=VALUE records", () => {
    expect(parseEnvOutput("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("keeps '=' inside a value", () => {
    expect(parseEnvOutput("FOO=a=b=c\n")).toEqual({ FOO: "a=b=c" });
  });

  // The whole reason the parser accepts more than newline KEY=VALUE: a PEM key or a
  // service-account JSON blob is exactly what an MCP server needs, and a newline-delimited
  // dump cannot represent it.
  it("carries a multi-line value through the NUL encoding", () => {
    expect(parseEnvOutput(`KEY=${PEM}\0OTHER=x\0`)).toEqual({ KEY: PEM, OTHER: "x" });
  });

  it("carries a multi-line value through the JSON encoding", () => {
    expect(parseEnvOutput(JSON.stringify({ KEY: PEM }))).toEqual({ KEY: PEM });
  });

  it("rejects a multi-line value in the newline encoding instead of truncating it", () => {
    // The newline encoding cannot represent a multi-line value. The KEY=VALUE check catches
    // the usual case, because a continuation line ("-----END KEY-----") has no "=".
    expect(() => parseEnvOutput(`KEY=${PEM}\n`)).toThrow(/expected KEY=VALUE/);
  });

  it("silently truncates a multi-line value whose every continuation line contains '=' (limitation)", () => {
    // The residual hole in the newline encoding, and the reason the docs steer multi-line
    // users to `env -0` or JSON: when each continuation line happens to look like a record,
    // there is nothing left to detect. NUL and JSON have no such failure mode.
    expect(parseEnvOutput("KEY=first\ncont=inuation\n")).toEqual({
      KEY: "first",
      cont: "inuation",
    });
  });

  it("throws on stdout chatter rather than importing half an environment", () => {
    expect(() => parseEnvOutput("loading .envrc\nFOO=bar\n")).toThrow(/expected KEY=VALUE/);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseEnvOutput("{not valid json}")).toThrow();
  });

  it("throws when the JSON payload is not an object", () => {
    expect(() => parseEnvOutput('["a","b"]')).toThrow();
  });

  it("throws on empty output", () => {
    expect(() => parseEnvOutput("   ")).toThrow(/no environment/);
  });

  it("preserves whitespace that is part of a value", () => {
    // Trimming the whole payload before splitting would silently corrupt the last secret.
    expect(parseEnvOutput("TOKEN=value \n")).toEqual({ TOKEN: "value " });
    expect(parseEnvOutput("TOKEN=value \0")).toEqual({ TOKEN: "value " });
  });
});

describe("resolveAgentEnvVars", () => {
  // A command layer that runs identically under bash and PowerShell: no shell builtins, no
  // POSIX-only tools. `env FOO=bar` would only work on the ubuntu CI leg.
  let fixtureDir: string;
  let printsFoo: string;
  let printsPath: string;
  let dumpsEnv: string;
  let failing: string;

  // PowerShell treats a quoted path in command position as a string EXPRESSION, not an
  // invocation — it needs the `&` call operator. bash has no such operator (there `&` would
  // background the job). Command strings are inherently shell-specific, so the fixture builds
  // the right one per platform; without this the Windows CI leg would fail these tests while
  // appearing to validate Windows support.
  function nodeCommand(script: string): string {
    const invocation = `"${process.execPath}" "${script}"`;
    return process.platform === "win32" ? `& ${invocation}` : invocation;
  }

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "paseo-agent-env-"));

    printsFoo = join(fixtureDir, "prints-foo.cjs");
    writeFileSync(printsFoo, 'process.stdout.write(JSON.stringify({ HOOK_FOO: "from-command" }));');

    // Echoes a var it inherited, so we can prove a command layer sees the layers before it.
    printsPath = join(fixtureDir, "prints-inherited.cjs");
    writeFileSync(
      printsPath,
      'process.stdout.write(JSON.stringify({ SAW: process.env.LAYER_ONE ?? "missing" }));',
    );

    // Prints the WHOLE environment, changing exactly one variable — the shape `direnv exec . env`
    // and `mise env --json` actually produce. This is what exercises the delta filter: a command
    // that only prints one key can never re-inject a daemon var, so it proves nothing.
    dumpsEnv = join(fixtureDir, "dumps-env.cjs");
    writeFileSync(
      dumpsEnv,
      'process.stdout.write(JSON.stringify({ ...process.env, HOOK_CHANGED: "yes" }));',
    );

    failing = join(fixtureDir, "fails.cjs");
    writeFileSync(failing, 'process.stderr.write("boom"); process.exit(3);');
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("injects static layers without running anything", async () => {
    const env = await resolveAgentEnvVars({
      layers: [{ kind: "static", vars: { A: "1", MULTI: PEM } }],
      cwd: process.cwd(),
    });
    expect(env).toEqual({ A: "1", MULTI: PEM });
  });

  it("captures the environment a command layer prints", async () => {
    const env = await resolveAgentEnvVars({
      layers: [{ kind: "command", command: nodeCommand(printsFoo) }],
      cwd: process.cwd(),
    });
    expect(env.HOOK_FOO).toBe("from-command");
  });

  it("merges layers left to right so the last one wins", async () => {
    const env = await resolveAgentEnvVars({
      layers: [
        { kind: "static", vars: { HOOK_FOO: "from-static" } },
        { kind: "command", command: nodeCommand(printsFoo) },
      ],
      cwd: process.cwd(),
    });
    expect(env.HOOK_FOO).toBe("from-command");

    const reversed = await resolveAgentEnvVars({
      layers: [
        { kind: "command", command: nodeCommand(printsFoo) },
        { kind: "static", vars: { HOOK_FOO: "from-static" } },
      ],
      cwd: process.cwd(),
    });
    expect(reversed.HOOK_FOO).toBe("from-static");
  });

  it("runs a command layer with the earlier layers already applied", async () => {
    const env = await resolveAgentEnvVars({
      layers: [
        { kind: "static", vars: { LAYER_ONE: "visible" } },
        { kind: "command", command: nodeCommand(printsPath) },
      ],
      cwd: process.cwd(),
    });
    expect(env.SAW).toBe("visible");
  });

  it("exposes the runtime env to the command", async () => {
    const env = await resolveAgentEnvVars({
      layers: [{ kind: "command", command: nodeCommand(printsPath) }],
      cwd: process.cwd(),
      runtimeEnv: { LAYER_ONE: "from-runtime" },
    });
    expect(env.SAW).toBe("from-runtime");
  });

  it("injects only what a command changed, not the whole environment it printed", async () => {
    const env = await resolveAgentEnvVars({
      layers: [{ kind: "command", command: nodeCommand(dumpsEnv) }],
      cwd: process.cwd(),
      runtimeEnv: { LAYER_ONE: "from-runtime" },
    });

    // The command printed its entire environment. Only the variable it actually changed is
    // injected — otherwise the daemon's whole env would land on the agent and clobber a user's
    // per-provider runtimeSettings.env for unrelated keys like PATH.
    expect(env.HOOK_CHANGED).toBe("yes");
    expect(env.PATH).toBeUndefined();
    expect(env.HOME ?? env.USERPROFILE).toBeUndefined();
    expect(env.LAYER_ONE).toBeUndefined();
    // Shell bookkeeping the login shell sets on its own is noise, not environment.
    expect(env.PWD).toBeUndefined();
    expect(env.SHLVL).toBeUndefined();
  });

  it("throws PreLaunchEnvError when a command layer exits non-zero", async () => {
    await expect(
      resolveAgentEnvVars({
        layers: [{ kind: "command", command: nodeCommand(failing) }],
        cwd: process.cwd(),
      }),
    ).rejects.toBeInstanceOf(PreLaunchEnvError);
  });

  it("keeps the command's output out of the error message", async () => {
    // The message reaches clients and the activity log. The output of an env tool is precisely
    // where secrets live, so it belongs in `detail` (daemon log) and nowhere else.
    const leaky = join(fixtureDir, "leaks.cjs");
    writeFileSync(leaky, 'process.stderr.write("SUPER_SECRET_TOKEN=hunter2"); process.exit(1);');
    const error = await resolveAgentEnvVars({
      layers: [{ kind: "command", command: nodeCommand(leaky) }],
      cwd: process.cwd(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PreLaunchEnvError);
    const failure = error as PreLaunchEnvError;
    expect(failure.message).not.toContain("hunter2");
    expect(failure.detail).toContain("hunter2");
  });

  it("throws PreLaunchEnvError when a command layer times out", async () => {
    const sleeper = join(fixtureDir, "sleeps.cjs");
    writeFileSync(sleeper, "setTimeout(() => {}, 5000);");
    await expect(
      resolveAgentEnvVars({
        layers: [{ kind: "command", command: nodeCommand(sleeper) }],
        cwd: process.cwd(),
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(PreLaunchEnvError);
  });
});
