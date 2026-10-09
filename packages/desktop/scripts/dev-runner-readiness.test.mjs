import http from "node:http";
import { expect, test } from "vitest";
import { waitForMetro } from "./dev-runner-readiness.mjs";

async function startMetroStatusServer(responses) {
  let lastResponse = null;
  let nextResponse = 0;
  const server = http.createServer((request, response) => {
    const reply = responses[Math.min(nextResponse++, responses.length - 1)];
    lastResponse = { path: request.url, ...reply };
    response.writeHead(reply.status);
    response.end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    lastResponse: () => lastResponse,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("Metro readiness rejects an unrelated listener before accepting the packager status", async () => {
  const metro = await startMetroStatusServer([
    { status: 503, body: "packager-status:running" },
    { status: 200, body: "unrelated HTTP server" },
    { status: 200, body: "packager-status:running" },
  ]);
  try {
    await waitForMetro(metro.url, 2_000);
    expect(metro.lastResponse()).toEqual({
      path: "/status",
      status: 200,
      body: "packager-status:running",
    });
  } finally {
    await metro.close();
  }
});
