import http from "node:http";
import { expect, test } from "vitest";
import { waitForMetro } from "./dev-runner-readiness.mjs";

test("Metro readiness rejects an unrelated listener before accepting the packager status", async () => {
  let status = 503;
  let body = "starting";
  let requested;
  let packagerStatusServed = false;
  let nextRequest = new Promise((resolve) => {
    requested = resolve;
  });
  const server = http.createServer((request, response) => {
    if (status === 200 && body === "packager-status:running") packagerStatusServed = true;
    response.writeHead(status);
    response.end(body);
    requested(request.url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let ready = false;
  const waiting = waitForMetro(url, 2_000).then(() => {
    ready = true;
    return ready;
  });
  try {
    // A TCP-only probe returns without making a readiness request.
    const first = await Promise.race([nextRequest, waiting.then(() => "premature readiness")]);
    expect(first).toBe("/status");
    expect(ready).toBe(false);
    status = 200;
    body = "unrelated HTTP server";
    nextRequest = new Promise((resolve) => {
      requested = resolve;
    });
    expect(await nextRequest).toBe("/status");
    expect(ready).toBe(false);
    body = "packager-status:running";
    await waiting;
    expect(ready).toBe(true);
    expect(packagerStatusServed).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await waiting.catch(() => {});
  }
});
