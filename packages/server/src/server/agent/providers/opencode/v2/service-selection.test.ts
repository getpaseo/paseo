import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { selectOpenCodeService } from "./service-selection.js";

test("selects the registered service with its credential and ignores stale registration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-service-"));
  const file = path.join(directory, "service.json");
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (
      request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`
    ) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ version: "2.0.10", pid: process.pid }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await writeFile(
      file,
      JSON.stringify({ url, password: "secret", pid: process.pid, version: "2.0.10" }),
    );
    expect(await selectOpenCodeService({ file })).toEqual({
      kind: "discovered",
      server: { url, password: "secret" },
    });
    expect(requests).toBe(1);
    expect(
      await selectOpenCodeService({ file, explicit: { url: "http://explicit.test" } }),
    ).toEqual({ kind: "explicit", server: { url: "http://explicit.test" } });
    expect(requests).toBe(1);
    await writeFile(file, JSON.stringify({ url, password: "secret", pid: process.pid + 1 }));
    expect(await selectOpenCodeService({ file })).toEqual({ kind: "owned" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});
