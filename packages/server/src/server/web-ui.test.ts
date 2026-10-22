import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import { createWebUiMiddleware } from "./web-ui.js";

const logger = pino({ level: "silent" });

interface ResponseSnapshot {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function readResponseBody(res: http.IncomingMessage): Promise<string> {
  let body = "";
  res.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf-8");
  });
  await once(res, "end");
  return body;
}

async function request(
  app: express.Application,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<ResponseSnapshot> {
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Server did not bind to a TCP port");
  }

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: requestPath,
          method,
          headers: { host: `localhost:${address.port}`, ...headers },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });

    const body = await readResponseBody(res);
    return {
      status: res.statusCode ?? 0,
      headers: res.headers,
      body,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createApp(options: {
  enabled: boolean;
  distDir: string | null;
  publicDir?: string;
}): express.Application {
  const app = express();
  app.use(
    createWebUiMiddleware({
      enabled: options.enabled,
      distDir: options.distDir,
      label: "test-label",
      logger,
    }),
  );
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/mcp/agents", (_req, res) => res.json({ mcp: true }));
  if (options.publicDir) {
    app.use("/public", express.static(options.publicDir));
  }
  return app;
}

describe("daemon web UI route module", () => {
  let tempRoot: string;
  let distDir: string;
  let publicDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-web-ui-"));
    distDir = path.join(tempRoot, "dist");
    publicDir = path.join(tempRoot, "public");
    await mkdir(path.join(distDir, "_expo", "static", "js", "web"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    await writeFile(
      path.join(distDir, "index.html"),
      "<!DOCTYPE html><html><head></head><body>app</body></html>",
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js"),
      "console.log('uncompressed');",
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js.br"),
      "console.log('brotli');",
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js.gz"),
      "console.log('gzip');",
    );
    await writeFile(path.join(distDir, "styles.css"), "body { color: red; }");
    await writeFile(path.join(publicDir, "asset.txt"), "public asset");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns 404 when web UI is disabled", async () => {
    const app = createApp({ enabled: false, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(404);
    expect(res.body).toBe("");
  });

  test("returns 404 when dist directory is missing", async () => {
    const app = createApp({ enabled: true, distDir: path.join(tempRoot, "missing"), publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(404);
  });

  test("serves index.html with injected initial connection hint", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
    expect(res.body).toContain('"listen":"localhost:');
    expect(res.body).toContain('"useTls":false');
    expect(res.body).toContain('"label":"test-label"');
  });

  test("injects hint before closing head tag", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/index.html");

    expect(res.body).toMatch(/window\.__PASEO_INITIAL_DAEMON_CONNECTION__.*<\/head>/);
  });

  test("escapes the injected host hint for inline script safety", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/", {
      host: "evil.test</script><script>alert(1)</script>",
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("evil.test\\u003C/script\\u003E");
    expect(res.body).not.toContain("evil.test</script>");
  });

  test("falls back to index.html for SPA deep links", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/h/some-server-id/agent/123");

    expect(res.status).toBe(200);
    expect(res.body).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
    expect(res.body).toContain("app");
  });

  test("serves static assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/styles.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(res.body).toBe("body { color: red; }");
  });

  test("selects brotli precompressed asset when accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
      "accept-encoding": "br, gzip",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.body).toBe("console.log('brotli');");
  });

  test("selects gzip precompressed asset when brotli is not accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
      "accept-encoding": "gzip",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.body).toBe("console.log('gzip');");
  });

  test("falls back to uncompressed asset when no encoding is accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe("console.log('uncompressed');");
  });

  test("does not catch /api/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  test("does not catch /mcp/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/mcp/agents");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"mcp":true}');
  });

  test("does not catch /public/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/public/asset.txt");

    expect(res.status).toBe(200);
    expect(res.body).toBe("public asset");
  });

  test("sets no-cache headers for index.html", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.headers["cache-control"]).toBe(
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
  });

  test("sets immutable caching for hashed assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js");

    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("sets no-cache for unhashed static assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/styles.css");

    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  test("only handles GET and HEAD requests", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });
    app.post("/", (_req, res) => res.json({ posted: true }));

    const res = await request(app, "POST", "/");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"posted":true}');
  });

  test("responds to HEAD without a body", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "HEAD", "/");

    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });
});
