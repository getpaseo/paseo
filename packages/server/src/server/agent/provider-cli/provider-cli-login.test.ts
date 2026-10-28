import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCliLoginSession } from "@getpaseo/protocol/provider-cli/rpc-schemas";
import {
  ProviderCliLoginProcess,
  extractDeviceCode,
  extractLoginUrl,
  normalizePtyOutput,
} from "./provider-cli-login";

describe("sign-in output parsing", () => {
  it("prefers the remote sign-in URL over a loopback callback", () => {
    const output =
      "Listening on http://localhost:54545/callback\nBrowse to https://claude.ai/oauth/authorize?code=true&state=abc).\n";
    expect(extractLoginUrl(output)).toBe("https://claude.ai/oauth/authorize?code=true&state=abc");
  });

  it("finds a device code but not fragments of the URL", () => {
    const output =
      "1. Open https://auth.openai.com/codex/device?x=ABCD-EFGHI\n2. Enter this one-time code: WXYZ-1234\n";
    expect(extractDeviceCode(output)).toBe("WXYZ-1234");
  });

  it("drops terminal escapes and carriage returns", () => {
    expect(normalizePtyOutput("\u001b[1mSign in\u001b[0m\r\nDone\r")).toBe("Sign in\nDone\n");
  });
});

describe("ProviderCliLoginProcess", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function writeScript(body: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "paseo-provider-login-"));
    const script = join(dir, "fake-login");
    await writeFile(script, `#!/bin/sh\n${body}\n`);
    await chmod(script, 0o755);
    return script;
  }

  function waitForExit(): {
    onExit: (status: ProviderCliLoginSession["status"]) => void;
    exited: Promise<ProviderCliLoginSession["status"]>;
  } {
    let resolve!: (status: ProviderCliLoginSession["status"]) => void;
    const exited = new Promise<ProviderCliLoginSession["status"]>((r) => {
      resolve = r;
    });
    return { onExit: resolve, exited };
  }

  it.skipIf(process.platform === "win32")(
    "relays the URL, accepts the pasted code, and succeeds when the CLI exits 0",
    async () => {
      const script = await writeScript(
        [
          'echo "Browse to https://example.com/oauth?state=1"',
          'printf "Paste code here if prompted > "',
          "read code",
          'if [ "$code" = "secret-code" ]; then echo "Login successful"; exit 0; fi',
          "exit 3",
        ].join("\n"),
      );
      const { onExit, exited } = waitForExit();
      const login = new ProviderCliLoginProcess({
        command: script,
        args: [],
        env: process.env,
        timeoutMs: 10_000,
        onExit,
      });

      await expect.poll(() => login.snapshot().url).toBe("https://example.com/oauth?state=1");
      await expect.poll(() => login.snapshot().output).toContain("Paste code here");
      login.write("secret-code");

      expect(await exited).toBe("succeeded");
      expect(login.snapshot()).toMatchObject({ status: "succeeded", error: null });
      expect(login.snapshot().output).toContain("Login successful");
    },
  );

  it.skipIf(process.platform === "win32")("reports a non-zero exit as a failure", async () => {
    const script = await writeScript('echo "not authorized"; exit 2');
    const { onExit, exited } = waitForExit();
    const login = new ProviderCliLoginProcess({
      command: script,
      args: [],
      env: process.env,
      timeoutMs: 10_000,
      onExit,
    });

    expect(await exited).toBe("failed");
    expect(login.snapshot().error).toBe("Sign-in exited with code 2");
  });

  it.skipIf(process.platform === "win32")("cancels a running sign-in", async () => {
    const script = await writeScript('echo "waiting"; sleep 30');
    const { onExit, exited } = waitForExit();
    const login = new ProviderCliLoginProcess({
      command: script,
      args: [],
      env: process.env,
      timeoutMs: 10_000,
      onExit,
    });
    await expect.poll(() => login.snapshot().output).toContain("waiting");

    login.cancel();

    expect(await exited).toBe("canceled");
    expect(() => login.write("late")).toThrow("Sign-in is no longer running");
  });
});
