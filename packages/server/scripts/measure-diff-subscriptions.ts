import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  encodeDiffFrame,
  DiffOpcode,
  type DiffFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { DiffSubscriptions } from "../src/server/diff/index.js";
import { createFileObserver } from "../src/server/file-observer/index.js";
import { runGitCommand } from "../src/utils/run-git-command.js";
import { parseAndHighlightDiff } from "../src/server/utils/diff-highlighter.js";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";

const cwd = resolve(import.meta.dirname, "../../..");
const artifacts = resolve(cwd, ".artifacts/diff-subscription");
await mkdir(artifacts, { recursive: true });
const pinnedHead = "3ed57e9dd";
const observer = createFileObserver();
const engine = new DiffSubscriptions({
  async requestWorkingTreeWatch(root, changed) {
    const watch = await observer.subscribe(root, () => changed(), {
      ignore: [resolve(root, ".git")],
    });
    return {
      repoRoot: root,
      unsubscribe: async () => {
        await watch.unsubscribe();
      },
    };
  },
});
try {
  for (const count of [1, 30]) {
    const [base, head] = await Promise.all([
      runGitCommand(["rev-parse", `${pinnedHead}~${count}`], { cwd }),
      runGitCommand(["rev-parse", pinnedHead], { cwd }),
    ]);
    const started = performance.now();
    const frames: DiffFrame[] = [];
    const encoded: Uint8Array[] = [];
    const subscription = await engine.subscribe(
      {
        cwd,
        base: { kind: "rev", rev: base.stdout.trim() },
        head: { kind: "rev", rev: head.stdout.trim() },
      },
      async (frame) => {
        frames.push(frame);
        encoded.push(encodeDiffFrame(frame));
      },
    );
    await subscription.start();
    const coldMs = performance.now() - started;
    await subscription.release();
    const raw = await runGitCommand(["diff", base.stdout.trim(), head.stdout.trim()], {
      cwd,
      maxOutputBytes: 50 * 1024 * 1024,
    });
    const contentAt = async (sha: string, path: string) => {
      const result = await runGitCommand(["show", `${sha}:${path}`], {
        cwd,
        acceptExitCodes: [0, 128],
      });
      return result.exitCode === 0 ? result.stdout : null;
    };
    const legacyFiles = await parseAndHighlightDiff(raw.stdout, cwd, {
      getOldFileContent: (file) => contentAt(base.stdout.trim(), file.path),
      getNewFileContent: (file) => contentAt(head.stdout.trim(), file.path),
    });
    const legacy = JSON.stringify({
      type: "session",
      message: {
        type: "checkout_diff_update",
        payload: { cwd, subscriptionId: "benchmark", files: legacyFiles, error: null },
      },
    });
    const parseStart = performance.now();
    const validation = validateWSOutboundMessage(JSON.parse(legacy));
    if (!validation.success) throw validation.error;
    const jsonParseValidationMs = performance.now() - parseStart;
    const begin = frames.find((frame) => frame.opcode === DiffOpcode.Begin);
    const end = frames.findLast((frame) => frame.opcode === DiffOpcode.End);
    if (!begin || begin.opcode !== DiffOpcode.Begin || !end || end.opcode !== DiffOpcode.End)
      throw new Error("Revision was not delimited");
    if (end.error) throw new Error(end.error.message);
    const metrics = {
      pinnedHead: head.stdout.trim(),
      count,
      files: begin.entries.length,
      rawPatchBytes: Buffer.byteLength(raw.stdout),
      encodedBytes: encoded.reduce((sum, bytes) => sum + bytes.length, 0),
      legacyJsonBytes: Buffer.byteLength(legacy),
      coldMs,
      jsonParseValidationMs,
      omitted: end.omitted,
    };
    console.log(JSON.stringify(metrics));
    await writeFile(
      resolve(artifacts, `corpus-${count}.json`),
      JSON.stringify({
        metrics,
        legacy,
        frames: encoded.map((bytes) => Buffer.from(bytes).toString("base64")),
      }),
    );
  }
} finally {
  await engine.close();
  await observer.close();
}
