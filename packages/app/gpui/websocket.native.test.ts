import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as WebSocketServer } from "ws";
import { expect, test } from "vitest";

const binary = process.env.PASEO_GPUI_TEST_BINARY;
const project = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(project, "../../..");

function createPeer() {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/reject") {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on("message", (message) => {
        websocket.send(message.toString());
        if (request.url === "/remote-close") websocket.close(1000, "server done");
      });
    });
  });
  return { server, sockets };
}

test.skipIf(!binary)(
  "native WebSocket retries and peer closes release their resources",
  async () => {
    mkdirSync(path.join(root, ".artifacts/gpui"), { recursive: true });
    const artifacts = mkdtempSync(path.join(root, ".artifacts/gpui/websocket-"));
    const bundle = path.join(artifacts, "regression.bundle");
    execFileSync(
      process.execPath,
      [
        "node_modules/react-native/cli.js",
        "bundle",
        "--platform",
        "desktop",
        "--entry-file",
        "websocket-regression.fixture.js",
        "--config",
        "desktop/metro.config.js",
        "--bundle-output",
        bundle,
        "--dev",
        "false",
        "--max-workers",
        "1",
      ],
      { cwd: project, env: { ...process.env, PASEO_RENDERER: "gpui" }, timeout: 120_000 },
    );

    const { server, sockets } = createPeer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    writeFileSync(
      bundle,
      `globalThis.__webSocketRegressionUrl = "ws://127.0.0.1:${address.port}";\n${readFileSync(bundle, "utf8")}`,
    );
    // Match Finder's descriptor limit even when the test shell has raised it.
    const app = spawn("/bin/sh", ["-c", 'ulimit -n 256; exec "$@"', "gpui-test", binary!], {
      env: {
        ...process.env,
        RN_GPUI_BUNDLE: bundle,
        RN_GPUI_APP_ID: "sh.paseo.gpui.websocket-test",
        XDG_DATA_HOME: path.join(artifacts, "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Native retry test timed out:\n${output}`)),
          60_000,
        );
        const collect = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("WEBSOCKET_REGRESSION_COMPLETE")) {
            clearTimeout(timeout);
            resolve();
          } else if (output.includes("WEBSOCKET_REGRESSION_FAIL")) {
            clearTimeout(timeout);
            reject(new Error(output));
          }
        };
        app.stdout.on("data", collect);
        app.stderr.on("data", collect);
        app.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        app.once("exit", (code, signal) => {
          clearTimeout(timeout);
          reject(new Error(`Native process exited (${code}, ${signal}):\n${output}`));
        });
      });
      expect(app.exitCode).toBeNull();
      expect(output).toContain("WEBSOCKET_REGRESSION_PASS reject");
      expect(output).toContain("WEBSOCKET_REGRESSION_PASS remote-close");
      expect(output).toContain("WEBSOCKET_REGRESSION_PASS local-close");
    } finally {
      writeFileSync(path.join(artifacts, "native.log"), output);
      app.kill("SIGTERM");
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.close();
    }
  },
  180_000,
);
