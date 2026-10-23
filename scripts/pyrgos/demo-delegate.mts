/**
 * Headless check of the action-item path: propose -> refine -> agree (announce line, then launch).
 * The launch hands the item to the harness dispatcher; it is a dry run unless PYRGOS_DEMO_LIVE=1.
 *
 *   PYRGOS_DISPATCH_CMD=<path to dispatch.sh> npx tsx scripts/pyrgos/demo-delegate.mts
 *
 * Env: PYRGOS_DISPATCH_CMD (required), ALCHEMIST_HARNESS (ledger directory), PYRGOS_DEMO_INBOX
 * (announce target, default a temp file), PYRGOS_DEMO_CWD (dispatch working directory), PYRGOS_DEMO_LIVE.
 * Exit 0 when the item is agreed, announced and the launch recorded no error.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAnnouncer,
  createVoiceSession,
} from "../../packages/server/src/server/pyrgos/ledger/feed.js";
import {
  createJsonlLedgerStore,
  ledgerFilePath,
  voiceFeedDir,
} from "../../packages/server/src/server/pyrgos/ledger/jsonl-store.js";
import { createLedger } from "../../packages/server/src/server/pyrgos/ledger/ledger.js";

const run = promisify(execFile);
const dispatch = process.env.PYRGOS_DISPATCH_CMD;
if (!dispatch) {
  console.error("set PYRGOS_DISPATCH_CMD to the dispatch.sh path");
  process.exit(2);
}
const live = process.env.PYRGOS_DEMO_LIVE === "1";
const inbox =
  process.env.PYRGOS_DEMO_INBOX ?? join(mkdtempSync(join(tmpdir(), "demo-")), "inbox.md");
const dir = voiceFeedDir();
const sessionId = `demo-${Date.now()}`;
const session = createVoiceSession({ dir, session: sessionId });

const ledger = createLedger({
  store: createJsonlLedgerStore(ledgerFilePath({ dir, session: sessionId })),
  announce: createAnnouncer({
    session,
    inboxPath: inbox,
    env: { ...process.env, VOICE_OVERSEER_SURFACE: "" },
  }),
  launch: async (item) => {
    const spec = `${item.item}. Scope: ${item.scope}. Done when: ${item.doneCriteria}. item:${item.id}`;
    const args = [
      "worker",
      spec,
      "--cwd",
      process.env.PYRGOS_DEMO_CWD ?? process.cwd(),
      "--test",
      "none",
    ];
    if (!live) args.push("--dry-run");
    const { stdout, stderr } = await run(dispatch, args, { maxBuffer: 1 << 20 });
    console.log(
      `launch (${live ? "live" : "dry run"}):`,
      (stderr || stdout).trim().split("\n").slice(-2).join(" | "),
    );
  },
});

await session.append("user", "Add a README line saying the demo ran.");
const draft = ledger.propose({ item: "Add a README line saying the demo ran" });
ledger.refine(draft.id, {
  scope: "README.md only",
  project: "pyrgos-paseo",
  doneCriteria: "one line added",
});
const agreed = await ledger.agree(draft.id, { confirmed: true });
const announced = readFileSync(inbox, "utf8").trim();
console.log(
  "state:",
  agreed.state,
  "| launchError:",
  agreed.launchError,
  "| announced:",
  announced.slice(0, 120),
);
process.exit(
  agreed.state === "agreed" && !agreed.launchError && announced.includes("[voice] ACTION") ? 0 : 1,
);
