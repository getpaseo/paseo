import { expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";
import { pasteTerminalImage, terminalImageInput } from "./terminal-image-input.js";
import { TerminalImageStore, terminalImageFileSystem } from "../server/host-clipboard.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const outcome of ["success", "failure", "cancel"] as const) {
  test(`real worker image paste ${outcome} orders input from multiple clients and leaves another PTY responsive`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "image-input-"));
    const manager = createWorkerTerminalManager();
    const gate = deferred();
    const writing = deferred();
    const abort = new AbortController();
    const store = new TerminalImageStore({
      directory: join(directory, "images"),
      isActive: (id) => Boolean(manager.getTerminal(id)),
      lifecycle: manager.fileLifecycle,
      filesystem: {
        ...terminalImageFileSystem,
        writeFile: async (...args: Parameters<typeof terminalImageFileSystem.writeFile>) => {
          if (String(args[0]).endsWith(".png")) {
            writing.resolve();
            await gate.promise;
            if (outcome === "failure")
              throw Object.assign(new Error("private path must stay internal"), { code: "ENOSPC" });
          }
          return terminalImageFileSystem.writeFile(...args);
        },
      },
    });
    const script = `const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdout.write('\\x1b[?2004hREADY'); process.stdin.on('data', data => fs.appendFileSync(process.argv[1], data));`;
    try {
      const terminals = await Promise.all(
        ["a", "b"].map((name) =>
          manager.createTerminal({
            cwd: directory,
            workspaceId: "image-ordering",
            command: process.execPath,
            args: ["-e", script, join(directory, name)],
          }),
        ),
      );
      const [a, b] = terminals;
      if (!a || !b) throw new Error("Missing terminal");
      await expect
        .poll(async () => (await manager.getTerminalState(a.id))?.replayPreamble)
        .toContain("?2004h");
      await expect
        .poll(async () => (await manager.getTerminalState(b.id))?.replayPreamble)
        .toContain("?2004h");
      const paste = pasteTerminalImage({
        terminal: a,
        manager,
        store,
        signal: abort.signal,
        image: { terminalId: a.id, mimeType: "image/png", dataBase64: "iVBORw0KGgo=" },
      });
      // Attach rejection handling before releasing the filesystem boundary.
      const result = paste.then(
        () => "success",
        (error: unknown) => error,
      );
      await writing.promise;
      terminalImageInput(a).input("first", (data) => a.send({ type: "input", data }));
      terminalImageInput(a).input("second\r", (data) => a.send({ type: "input", data }));
      terminalImageInput(b).input("other", (data) => b.send({ type: "input", data }));
      b.send({ type: "resize", rows: 30, cols: 90 });
      await expect.poll(() => readFile(join(directory, "b"), "utf8").catch(() => "")).toBe("other");
      expect(await readFile(join(directory, "a"), "utf8").catch(() => "")).toBe("");
      if (outcome === "cancel") abort.abort();
      gate.resolve();
      if (outcome === "success") {
        expect(await result).toBe("success");
        await expect
          .poll(() => readFile(join(directory, "a"), "utf8").catch(() => ""))
          .toEqual(expect.stringContaining("\x1b[201~firstsecond\r"));
        expect((await readFile(join(directory, "a"), "utf8")).startsWith("\x1b[200~")).toBe(true);
      } else {
        expect(await result).toMatchObject({
          code: outcome === "failure" ? "disk_full" : "upload_failed",
        });
        await expect
          .poll(() => readFile(join(directory, "a"), "utf8").catch(() => ""))
          .toBe("firstsecond");
      }
      for (const terminal of terminals)
        await terminal.killAndWait({ gracefulTimeoutMs: 100, forceTimeoutMs: 500 });
    } finally {
      gate.resolve();
      abort.abort();
      manager.killAll();
      await store.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
