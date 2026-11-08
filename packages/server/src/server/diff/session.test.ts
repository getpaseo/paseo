import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { expect, test } from "vitest";
import {
  decodeDiffFrame,
  DiffOpcode,
  type DiffFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { DiffSession, DiffSubscriptions } from "./index.js";
import { createFileObserver } from "../file-observer/index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";

test("a failed physical send releases that subscriber while its sibling completes the revision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-send-failure-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const observer = createFileObserver();
  const subscriptions = new DiffSubscriptions({
    async requestWorkingTreeWatch(root, changed) {
      const watch = await observer.subscribe(root, () => changed(), {
        ignore: [join(root, ".git")],
      });
      return {
        repoRoot: root,
        unsubscribe: async () => {
          await watch.unsubscribe();
        },
      };
    },
  });
  const first = {};
  const second = {};
  let failFirst = false;
  const firstFrames: DiffFrame[] = [];
  const secondFrames: DiffFrame[] = [];
  const delivery = new SessionDelivery(
    () => {},
    async (source, bytes) => {
      if (source === first && failFirst) throw new Error("Physical send failed");
      const frame = decodeDiffFrame(bytes);
      const received = source === first ? firstFrames : secondFrames;
      received.push(frame);
    },
  );
  delivery.attach(first, true);
  delivery.attach(second, true);
  const session = new DiffSession(subscriptions, pino({ level: "silent" }));
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "x.ts"), "export const value = 1;\n");
    for (const [source, requestId] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      const message = {
        type: "diff.subscribe.request" as const,
        requestId,
        cwd,
        base: { kind: "rev" as const, rev: "HEAD" },
        head: { kind: "worktree" as const },
      };
      await delivery.request(source, message, () => session.subscribe(message, delivery, () => {}));
      const received = source === first ? firstFrames : secondFrames;
      await waitForEnd(received);
    }
    secondFrames.length = 0;
    failFirst = true;
    await writeFile(join(cwd, "x.ts"), "export const value = 2;\n");
    await waitForEnd(secondFrames);
    const begins = secondFrames
      .filter((frame) => frame.opcode === DiffOpcode.Begin)
      .map((frame) => frame.revision);
    expect(new Set(begins).size).toBe(begins.length);
    expect(secondFrames.at(-1)).toMatchObject({ opcode: DiffOpcode.End, error: null });
    expect(delivery.subscriptionIds(first, "diffs")).toEqual([]);
    expect(delivery.subscriptionIds(second, "diffs")).toHaveLength(1);
  } finally {
    await delivery.close();
    await subscriptions.close();
    await observer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

async function waitForEnd(frames: DiffFrame[]): Promise<void> {
  await expect
    .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End), { timeout: 10000 })
    .toBe(true);
}
