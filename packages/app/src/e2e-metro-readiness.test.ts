import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { waitForMetro, warmMetro } from "../e2e/support/global-setup";

interface MetroExclusionsConfig {
  resolver: { blockList: RegExp | RegExp[] };
}

const requireMetroConfig = createRequire(import.meta.url);
const appDirectory = path.resolve(import.meta.dirname, "..");

function metroBlocks(config: MetroExclusionsConfig, filePath: string): boolean {
  const patterns = Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : [config.resolver.blockList];
  return patterns.some((pattern) => pattern.test(filePath));
}

// On Windows, the crawler uses backslashes and the watcher normalizes them to slashes.
test.each([path.win32.sep, path.posix.sep])(
  "Metro excludes server output and retains app dependencies with %s separators",
  (separator) => {
    const config = requireMetroConfig("../metro.config.cjs") as MetroExclusionsConfig;
    const serverDist = path.resolve(appDirectory, "../server/dist");
    for (const excluded of [
      serverDist,
      path.join(serverDist, "server/builtin-plugins/kimi-usage-source"),
      path.join(serverDist, "server/builtin-plugins/shared/index.js"),
      path.join(appDirectory, "src/components/message.test.tsx"),
    ]) {
      const filePath = excluded.split(path.sep).join(separator);
      expect(metroBlocks(config, filePath), filePath).toBe(true);
    }
    for (const included of [
      path.join(appDirectory, "src/components/message.tsx"),
      path.resolve(appDirectory, "../server/src/server/exports.ts"),
      path.resolve(appDirectory, "../server/dist-extra/index.js"),
      ...["client", "protocol", "relay"].map((name) =>
        path.resolve(appDirectory, `../${name}/dist/index.js`),
      ),
    ]) {
      const filePath = included.split(path.sep).join(separator);
      expect(metroBlocks(config, filePath), filePath).toBe(false);
    }
  },
);

test("Metro preserves Expo's cache and native build exclusions", () => {
  const config = requireMetroConfig("../metro.config.cjs") as MetroExclusionsConfig;
  const { getDefaultConfig } = requireMetroConfig("expo/metro-config") as {
    getDefaultConfig(projectRoot: string): MetroExclusionsConfig;
  };
  const defaults = getDefaultConfig(appDirectory);
  const defaultPatterns = Array.isArray(defaults.resolver.blockList)
    ? defaults.resolver.blockList
    : [defaults.resolver.blockList];
  expect(config.resolver.blockList).toEqual(expect.arrayContaining(defaultPatterns));
  for (const excluded of [
    ".expo/types",
    ".expo/web/cache",
    "android/app/build",
    "android/.gradle",
    "ios/Pods",
  ]) {
    expect(metroBlocks(config, excluded.split("/").join(path.sep)), excluded).toBe(true);
  }
});

class MetroPort {
  private readonly responses = new Map<string, { status: number; body: string }>();
  readonly requests: string[] = [];

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async listen(): Promise<MetroPort> {
    let endpoint!: MetroPort;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      endpoint.requests.push(pathname);
      const served = endpoint.responses.get(pathname) ?? { status: 500, body: "fallback" };
      response.writeHead(served.status, { "content-type": "text/plain" });
      response.end(served.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to listen for Metro readiness test");
    }
    endpoint = new MetroPort(address.port, server);
    return endpoint;
  }

  serveMetro(): void {
    this.responses.set("/status", { status: 200, body: "packager-status:running" });
  }

  serveWarmableDocument(): void {
    this.responses.set("/", {
      status: 200,
      body: '<html><script src="/index.bundle?platform=web"></script></html>',
    });
    this.responses.set("/index.bundle", { status: 200, body: "compiled bundle" });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

let endpoint: MetroPort | null = null;

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
});

test("Metro readiness rejects another HTTP listener on the selected port", async () => {
  endpoint = await MetroPort.listen();

  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).rejects.toThrow(
    "Expected Metro status",
  );

  endpoint.serveMetro();
  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).resolves.toBe(
    undefined,
  );
});

test("Metro warmup compiles the document's same-origin scripts before tests start", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();

  await warmMetro(endpoint.port);

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
});
