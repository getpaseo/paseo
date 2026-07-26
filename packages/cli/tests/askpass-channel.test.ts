import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyAskpassPrompt,
  createAskpassChannel,
  type AskpassRequest,
} from "../src/ssh/askpass-channel.js";

/** Invoke the generated askpass exactly as ssh does: prompt as argv[1]. */
function runAskpass(
  askpassPath: string,
  prompt: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(askpassPath, [prompt], { timeout: 20_000 }, (error, stdout) => {
      if (!error) {
        resolve({ stdout, code: 0 });
        return;
      }
      const reported = (error as { code?: unknown }).code;
      resolve({ stdout, code: typeof reported === "number" ? reported : 1 });
    });
  });
}

describe("askpass-channel: prompt classification", () => {
  it("tells a key passphrase from an account password", () => {
    expect(classifyAskpassPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toBe(
      "passphrase",
    );
    expect(classifyAskpassPrompt("alice@example.com's password: ")).toBe("password");
    // Unknown prompts default to the far more common case.
    expect(classifyAskpassPrompt("Password: ")).toBe("password");
  });
});

describe("askpass-channel", () => {
  it("relays the prompt to the handler and the answer back on stdout", async () => {
    const seen: AskpassRequest[] = [];
    const channel = await createAskpassChannel({
      onPrompt: async (request) => {
        seen.push(request);
        return "s3cret";
      },
    });
    try {
      const result = await runAskpass(channel.askpassPath, "alice@example.com's password: ");
      // stdout is the only channel ssh reads a secret from.
      expect(result.stdout).toBe("s3cret");
      expect(result.code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.kind).toBe("password");
      expect(seen[0]?.prompt).toBe("alice@example.com's password: ");
    } finally {
      channel.close();
    }
  });

  it("aborts the signal and emits nothing when the prompt is declined", async () => {
    const channel = await createAskpassChannel({ onPrompt: async () => null });
    try {
      expect(channel.signal.aborted).toBe(false);
      const result = await runAskpass(channel.askpassPath, "alice@example.com's password: ");
      // An empty answer must never be offered to ssh as a password.
      expect(result.stdout).toBe("");
      expect(result.code).not.toBe(0);
      expect(channel.signal.aborted).toBe(true);
    } finally {
      channel.close();
    }
  });

  it("declines rather than hanging ssh when no answer arrives in time", async () => {
    const channel = await createAskpassChannel({
      onPrompt: () => new Promise<string | null>(() => {}),
      promptTimeoutMs: 250,
    });
    try {
      const result = await runAskpass(channel.askpassPath, "alice@example.com's password: ");
      expect(result.stdout).toBe("");
      expect(channel.signal.aborted).toBe(true);
    } finally {
      channel.close();
    }
  });

  it("exits instead of blocking when the channel is already closed", async () => {
    const channel = await createAskpassChannel({ onPrompt: async () => "unused" });
    const askpassPath = channel.askpassPath;
    channel.close();
    // The socket is gone; ssh must not be left waiting on a dead relay.
    const result = await runAskpass(askpassPath, "alice@example.com's password: ");
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
  });

  it("keeps the socket and helper in a private directory", async () => {
    const channel = await createAskpassChannel({ onPrompt: async () => null });
    try {
      const wrapper = readFileSync(channel.askpassPath, "utf8");
      // The helper needs a runtime; under Electron that is the app binary in
      // Node mode, which is inert for a plain node.
      expect(wrapper).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(wrapper).toContain(path.dirname(channel.askpassPath));
      // Written at runtime, so there is no packaged asset to unpack from asar.
      expect(
        readFileSync(path.join(path.dirname(channel.askpassPath), "askpass-helper.cjs"), "utf8"),
      ).toContain("net.connect");
    } finally {
      channel.close();
    }
  });
});
