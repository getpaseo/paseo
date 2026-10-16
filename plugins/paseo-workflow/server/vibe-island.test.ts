import { mkdtemp, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { endVibeIslandSession } from "./vibe-island";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function bridge(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-vibe-"));
  directories.push(dir);
  const file = path.join(dir, "bridge");
  await writeFile(file, `#!${process.execPath}\n${body}`);
  await chmod(file, 0o700);
  return { file, output: path.join(dir, "event.json") };
}
test("sends SessionEnd with the source provider, native id and directory to the bridge", async () => {
  const { file, output } = await bridge(
    `let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'event.json'), JSON.stringify({args: process.argv.slice(2), event: JSON.parse(data)})));`,
  );
  await endVibeIslandSession(
    { provider: "codex", sessionId: "native-source", cwd: "/space with 'quotes'" },
    file,
  );
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
    args: ["--source", "codex"],
    event: {
      hook_event_name: "SessionEnd",
      session_id: "native-source",
      cwd: "/space with 'quotes'",
    },
  });
});
test("ignores an absent optional bridge", async () => {
  await expect(
    endVibeIslandSession(
      { provider: "claude", sessionId: "source", cwd: "/workspace" },
      path.join(tmpdir(), "missing-vibe-bridge"),
    ),
  ).resolves.toBeUndefined();
});
test("logs a bridge failure without failing the handoff", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { file } = await bridge("process.exit(1)");
  await expect(
    endVibeIslandSession({ provider: "claude", sessionId: "source", cwd: "/workspace" }, file),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
});
test("terminates a stalled bridge within a bounded delay", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { file } = await bridge("setInterval(() => {}, 1000)");
  const start = Date.now();
  await endVibeIslandSession({ provider: "codex", sessionId: "source", cwd: "/workspace" }, file);
  expect(Date.now() - start).toBeLessThan(4000);
  expect(warn).toHaveBeenCalledOnce();
});
