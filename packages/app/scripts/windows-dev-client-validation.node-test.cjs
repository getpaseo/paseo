const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  buildSpawnInvocation,
  buildConfig,
  buildDeepLinkUrl,
  buildExpoEnv,
  rewriteExpoManifestResponse,
  buildUpstreamRequestHeaders,
  classifyValidationResult,
  deriveValidationOutcome,
  parseArgs,
  shouldEndUpstreamImmediately,
  spawnCapture,
  waitForExpoReady,
  runValidation,
} = require("./windows-dev-client-validation.cjs");

test("buildDeepLinkUrl encodes the localhost launch target for Expo dev client", () => {
  assert.equal(
    buildDeepLinkUrl({
      scheme: "exp+voice-mobile",
      launchHost: "127.0.0.1",
      port: 8097,
    }),
    "exp+voice-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8097",
  );
});

test("buildExpoEnv clears proxy variables and extends NO_PROXY for localhost", () => {
  const env = buildExpoEnv(
    {
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8080",
      ALL_PROXY: "socks5://proxy.example.test:1080",
      NO_PROXY: "example.test",
      Path: "C:\\Windows\\System32",
    },
    {
      keepProxyEnv: false,
      envOverrides: {
        EXPO_NO_METRO_WORKSPACE_ROOT: "1",
      },
    },
  );

  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.EXPO_NO_METRO_WORKSPACE_ROOT, "1");
  assert.equal(env.Path, "C:\\Windows\\System32");
  assert.match(env.NO_PROXY, /(^|,)example\.test(,|$)/);
  assert.match(env.NO_PROXY, /(^|,)localhost(,|$)/);
  assert.match(env.NO_PROXY, /(^|,)127\.0\.0\.1(,|$)/);
});

test("parseArgs accepts repeated env overrides and skip flags", () => {
  const args = parseArgs([
    "--port",
    "8098",
    "--host",
    "localhost",
    "--device-id",
    "f66d9150",
    "--env",
    "EXPO_NO_METRO_WORKSPACE_ROOT=1",
    "--env",
    "EXPO_USE_FAST_RESOLVER=0",
    "--skip-build-workspace-deps",
    "--skip-ui-dump",
  ]);

  assert.equal(args.port, 8098);
  assert.equal(args.host, "localhost");
  assert.equal(args.deviceId, "f66d9150");
  assert.equal(args.buildWorkspaceDeps, false);
  assert.equal(args.captureUiDump, false);
  assert.deepEqual(args.envOverrides, {
    EXPO_NO_METRO_WORKSPACE_ROOT: "1",
    EXPO_USE_FAST_RESOLVER: "0",
  });
});

test("parseArgs accepts request capture and retry flags", () => {
  const args = parseArgs(["--port", "8104", "--capture-first-request", "--retry-on-timeout"]);

  assert.equal(args.port, 8104);
  assert.equal(args.captureFirstRequest, true);
  assert.equal(args.retryOnTimeout, true);
});

test("classifyValidationResult detects successful app boot from the UI dump", () => {
  const result = classifyValidationResult({
    uiDumpXml: '<node text="Welcome to Paseo" />',
    logcatText: "",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "app_loaded");
  assert.equal(result.reason, "success_text_visible");
});

test("classifyValidationResult detects Android read timeouts from logcat", () => {
  const result = classifyValidationResult({
    uiDumpXml: '<node text="Loading..." />',
    logcatText:
      "sh.paseo.debug expo.modules.devlauncher.launcher.errors.DevLauncherErrorActivity java.net.SocketTimeoutException: Read timed out\nCaused by: java.net.SocketTimeoutException: timeout",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "dev_client_read_timeout");
  assert.equal(result.reason, "logcat_socket_timeout");
});

test("classifyValidationResult prefers the Expo error page text from the UI dump", () => {
  const result = classifyValidationResult({
    uiDumpXml:
      '<node text="There was a problem loading the project." /><node text="java.net.SocketTimeoutException: timeout" />',
    logcatText: "",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "dev_client_read_timeout");
  assert.equal(result.reason, "ui_dump_socket_timeout");
});

test("classifyValidationResult detects a usable workspace UI without relying on welcome copy", () => {
  const result = classifyValidationResult({
    uiDumpXml: [
      "<hierarchy>",
      '<node package="sh.paseo.debug" resource-id="workspace-header-title" text="codex_device_reopen_test" />',
      '<node package="sh.paseo.debug" resource-id="message-input-root" text="" />',
      '<node package="sh.paseo.debug" resource-id="agent-chat-scroll" text="" />',
      "</hierarchy>",
    ].join(""),
    logcatText: "",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "app_loaded");
  assert.equal(result.reason, "workspace_ui_visible");
});

test("classifyValidationResult prefers visible workspace UI over timeout-only logcat noise", () => {
  const result = classifyValidationResult({
    uiDumpXml: [
      "<hierarchy>",
      '<node package="sh.paseo.debug" resource-id="workspace-header-title" text="codex_device_reopen_test" />',
      '<node package="sh.paseo.debug" resource-id="message-input-root" text="" />',
      "</hierarchy>",
    ].join(""),
    logcatText:
      "sh.paseo.debug expo.modules.devlauncher.launcher.errors.DevLauncherErrorActivity java.net.SocketTimeoutException: Read timed out",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "app_loaded");
  assert.equal(result.reason, "workspace_ui_visible");
});

test("classifyValidationResult ignores unrelated logcat timeouts when the app UI is inconclusive", () => {
  const result = classifyValidationResult({
    uiDumpXml: '<node text="Loading..." />',
    logcatText:
      "Play services background sync failed with java.net.SocketTimeoutException: failed to connect to play.googleapis.com",
    launchOutput: "Starting: Intent { ... }",
    successText: "Welcome to Paseo",
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "no_success_or_failure_signature");
});

test("buildSpawnInvocation routes npm.cmd through cmd.exe on Windows", () => {
  assert.deepEqual(buildSpawnInvocation("npm", ["run", "build:workspace-deps"], "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "run", "build:workspace-deps"],
  });
});

test("buildSpawnInvocation leaves adb untouched on Windows", () => {
  assert.deepEqual(buildSpawnInvocation("adb", ["devices"], "win32"), {
    command: "adb",
    args: ["devices"],
  });
});

test("spawnCapture rejects when a command exceeds timeoutMs", async () => {
  await assert.rejects(
    () =>
      spawnCapture(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        timeoutMs: 50,
      }),
    (error) => {
      assert.equal(error.timedOut, true);
      assert.equal(error.command, process.execPath);
      assert.equal(error.timeoutMs, 50);
      assert.match(error.message, /timed out after 50ms/);
      return true;
    },
  );
});

test("buildConfig offsets Metro to a private upstream port when request capture is enabled", () => {
  const config = buildConfig(
    {
      port: 8104,
      host: "lan",
      launchHost: "127.0.0.1",
      deviceId: null,
      appId: "sh.paseo.debug",
      scheme: "exp+voice-mobile",
      outputDir: "/tmp/out",
      waitMs: 15000,
      startupTimeoutMs: 120000,
      successText: "Welcome to Paseo",
      envOverrides: {},
      keepProxyEnv: false,
      buildWorkspaceDeps: true,
      adbReverse: true,
      captureScreenshot: true,
      captureUiDump: true,
      clearLogcat: true,
      captureFirstRequest: true,
      retryOnTimeout: false,
      help: false,
    },
    {
      repoRoot: "/repo",
      baseEnv: {},
    },
  );

  assert.equal(config.publicPort, 8104);
  assert.equal(config.metroPort, 8105);
  assert.equal(
    config.deepLinkUrl,
    "exp+voice-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8104",
  );
  assert.match(config.artifactPaths.requestCapture, /request-capture\.json$/);
  assert.match(config.artifactPaths.requestReplay, /request-replay\.json$/);
});

test("runValidation records a completed timeout summary when adb enumeration hangs", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-validation-timeout-"));
  const config = buildConfig(
    {
      port: 8108,
      host: "lan",
      launchHost: "127.0.0.1",
      deviceId: "f66d9150",
      appId: "sh.paseo.debug",
      scheme: "exp+voice-mobile",
      outputDir,
      waitMs: 1,
      startupTimeoutMs: 1000,
      successText: "Welcome to Paseo",
      envOverrides: {},
      keepProxyEnv: false,
      buildWorkspaceDeps: false,
      adbReverse: false,
      captureScreenshot: false,
      captureUiDump: false,
      clearLogcat: false,
      help: false,
      captureFirstRequest: false,
      retryOnTimeout: false,
    },
    {
      repoRoot: "/repo",
      appDir: "/repo/packages/app",
      baseEnv: {},
    },
  );
  const timeoutError = new Error("adb devices timed out after 25ms");
  timeoutError.timedOut = true;
  timeoutError.command = "adb";
  timeoutError.args = ["devices"];
  timeoutError.timeoutMs = 25;

  try {
    const summary = await runValidation(config, {
      spawnCapture: async (command, args) => {
        assert.equal(command, "adb");
        assert.deepEqual(args, ["devices"]);
        throw timeoutError;
      },
      startRequestCaptureProxy: () => {
        throw new Error("request capture should not start before adb devices succeeds");
      },
      startExpoProcess: () => {
        throw new Error("Expo should not start before adb devices succeeds");
      },
    });

    assert.equal(summary.phase, "completed");
    assert.equal(summary.status, "command_timeout");
    assert.equal(summary.reason, "adb_devices_timeout");
    assert.equal(summary.failedPhase, "adb_devices");
    assert.deepEqual(summary.timedOutCommand, {
      command: "adb",
      args: ["devices"],
      timeoutMs: 25,
    });

    const writtenSummary = JSON.parse(
      fs.readFileSync(path.join(outputDir, "summary.json"), "utf8"),
    );
    assert.equal(writtenSummary.phase, "completed");
    assert.equal(writtenSummary.status, "command_timeout");
    assert.equal(writtenSummary.reason, "adb_devices_timeout");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("runValidation persists failing adb devices output for later inspection", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-validation-adb-failure-"));
  const config = buildConfig(
    {
      port: 8109,
      host: "lan",
      launchHost: "127.0.0.1",
      deviceId: "f66d9150",
      appId: "sh.paseo.debug",
      scheme: "exp+voice-mobile",
      outputDir,
      waitMs: 1,
      startupTimeoutMs: 1000,
      successText: "Welcome to Paseo",
      envOverrides: {},
      keepProxyEnv: false,
      buildWorkspaceDeps: false,
      adbReverse: false,
      captureScreenshot: false,
      captureUiDump: false,
      clearLogcat: false,
      help: false,
      captureFirstRequest: false,
      retryOnTimeout: false,
    },
    {
      repoRoot: "/repo",
      appDir: "/repo/packages/app",
      baseEnv: {},
    },
  );
  const exitError = new Error("adb devices exited with code 1\nadb server version mismatch");
  exitError.command = "adb";
  exitError.args = ["devices"];
  exitError.commandExitCode = 1;
  exitError.stdout = "List of devices attached\n";
  exitError.stderr = "adb server version mismatch\n";

  try {
    const summary = await runValidation(config, {
      spawnCapture: async () => {
        throw exitError;
      },
    });

    assert.equal(summary.status, "validation_failed");
    assert.equal(summary.reason, "adb_devices_failed");
    assert.deepEqual(summary.failedCommand, {
      command: "adb",
      args: ["devices"],
      exitCode: 1,
      timeoutMs: null,
    });
    assert.equal(
      fs.readFileSync(path.join(outputDir, "adb-devices.txt"), "utf8"),
      "List of devices attached\nadb server version mismatch\n",
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("buildUpstreamRequestHeaders rewrites host to Metro and strips hop-by-hop headers", () => {
  assert.deepEqual(
    buildUpstreamRequestHeaders(
      {
        host: "127.0.0.1:8106",
        connection: "Keep-Alive",
        "proxy-connection": "keep-alive",
        "keep-alive": "timeout=4",
        "transfer-encoding": "chunked",
        "content-length": "0",
        "expo-platform": "android",
        accept: "application/expo+json,application/json",
        "expo-dev-client-id": "cebcd768-706b-416a-9b8e-22c85b93d7f1",
        "user-agent": "okhttp/4.12.0",
      },
      {
        publicPort: 8106,
        metroPort: 8107,
      },
    ),
    {
      host: "127.0.0.1:8107",
      "expo-platform": "android",
      accept: "application/expo+json,application/json",
      "expo-dev-client-id": "cebcd768-706b-416a-9b8e-22c85b93d7f1",
      "user-agent": "okhttp/4.12.0",
    },
  );
});

test("rewriteExpoManifestResponse rewrites expo+json payload URLs back to the public proxy port", () => {
  const response = rewriteExpoManifestResponse(
    {
      "content-type": "application/expo+json",
      "content-length": "99",
    },
    JSON.stringify({
      launchAsset: {
        url: "http://127.0.0.1:8119/packages/app/index.ts.bundle?platform=android",
      },
      extra: {
        expoClient: {
          hostUri: "127.0.0.1:8119",
          iconUrl: "http://127.0.0.1:8119/assets/icon.png",
        },
      },
    }),
    {
      publicPort: 8118,
      metroPort: 8119,
    },
  );

  assert.equal(response.rewritten, true);
  assert.match(response.bodyText, /127\.0\.0\.1:8118/);
  assert.doesNotMatch(response.bodyText, /127\.0\.0\.1:8119/);
  assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.bodyText));
});

test("rewriteExpoManifestResponse rewrites multipart Expo manifests back to the public proxy port", () => {
  const bodyText = [
    "--formdata-123",
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json",
    "",
    '{"launchAsset":{"url":"http://127.0.0.1:8119/packages/app/index.ts.bundle?platform=android"},"extra":{"expoClient":{"hostUri":"127.0.0.1:8119"}}}',
    "--formdata-123--",
    "",
  ].join("\r\n");
  const response = rewriteExpoManifestResponse(
    {
      "content-type": "multipart/mixed; boundary=formdata-123",
      "content-length": String(Buffer.byteLength(bodyText)),
    },
    bodyText,
    {
      publicPort: 8118,
      metroPort: 8119,
    },
  );

  assert.equal(response.rewritten, true);
  assert.match(response.bodyText, /127\.0\.0\.1:8118/);
  assert.doesNotMatch(response.bodyText, /127\.0\.0\.1:8119/);
  assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.bodyText));
});

test("shouldEndUpstreamImmediately treats HEAD without request-body headers as bodyless", () => {
  assert.equal(
    shouldEndUpstreamImmediately({
      method: "HEAD",
      headers: {
        host: "127.0.0.1:8108",
        connection: "Keep-Alive",
      },
    }),
    true,
  );
});

test("shouldEndUpstreamImmediately keeps POST with content-length on the buffered path", () => {
  assert.equal(
    shouldEndUpstreamImmediately({
      method: "POST",
      headers: {
        host: "127.0.0.1:8108",
        "content-length": "42",
      },
    }),
    false,
  );
});

test("waitForExpoReady keeps probing until the dev-client manifest probe succeeds", async () => {
  const probeCalls = [];
  let writePayload = null;
  const config = {
    metroPort: 8111,
    startupTimeoutMs: 1000,
    artifactPaths: {
      expoProbe: path.join(os.tmpdir(), "windows-dev-client-validation-ready-probe.json"),
    },
  };
  const expoProcess = {
    child: { exitCode: null },
    getOutput() {
      return "Waiting on http://localhost:8111\nLogs for your project will appear below.";
    },
  };

  const result = await waitForExpoReady(config, expoProcess, {
    now: (() => {
      let tick = 0;
      return () => tick++;
    })(),
    sleep: async () => {},
    writeJson(payloadPath, payload) {
      assert.equal(payloadPath, config.artifactPaths.expoProbe);
      writePayload = payload;
    },
    probe(requestOptions) {
      probeCalls.push(requestOptions);
      if (requestOptions.url.endsWith("/status")) {
        return Promise.resolve({
          ok: true,
          statusCode: 200,
          headers: {},
          bodyPreview: "packager-status:running",
        });
      }
      return Promise.resolve({
        ok: true,
        statusCode: 200,
        headers: {
          "content-type": "application/expo+json",
        },
        bodyPreview: "",
      });
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/expo+json");
  assert.equal(probeCalls.length, 2);
  assert.match(probeCalls[0].url, /\/status$/);
  assert.equal(probeCalls[0].headers, undefined);
  assert.equal(probeCalls[1].headers.accept, "application/expo+json,application/json");
  assert.equal(probeCalls[1].headers["expo-dev-client-id"], undefined);
  assert.equal(writePayload.statusCode, 200);
  assert.equal(writePayload.headers["content-type"], "application/expo+json");
  assert.equal(writePayload.probeType, "dev_client_manifest");
});

test("waitForExpoReady keeps warming after Metro status until the manifest probe succeeds", async () => {
  const probeCalls = [];
  const writePayloads = [];
  const config = {
    metroPort: 8123,
    startupTimeoutMs: 5000,
    artifactPaths: {
      expoProbe: path.join(os.tmpdir(), "windows-dev-client-validation-status-probe.json"),
    },
  };
  const expoProcess = {
    child: { exitCode: null },
    getOutput() {
      return "Waiting on http://localhost:8123\nLogs for your project will appear below.";
    },
  };

  const result = await waitForExpoReady(config, expoProcess, {
    now: (() => {
      let tick = 0;
      return () => (tick += 100);
    })(),
    sleep: async () => {},
    writeJson(payloadPath, payload) {
      assert.equal(payloadPath, config.artifactPaths.expoProbe);
      writePayloads.push(payload);
    },
    async probe(requestOptions) {
      probeCalls.push(requestOptions);
      if (requestOptions.url.endsWith("/status")) {
        return {
          ok: true,
          statusCode: 200,
          headers: {},
          bodyPreview: "packager-status:running",
        };
      }

      if (probeCalls.filter((call) => call.method === "HEAD").length === 1) {
        throw new Error("probe timeout");
      }

      return {
        ok: true,
        statusCode: 200,
        headers: {
          "content-type": "application/expo+json",
        },
        bodyPreview: "",
      };
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/expo+json");
  assert.equal(probeCalls.length, 4);
  assert.match(probeCalls[0].url, /\/status$/);
  assert.equal(probeCalls[1].timeoutMs, 20000);
  assert.equal(probeCalls[3].timeoutMs, 20000);
  assert.equal(writePayloads.length, 2);
  assert.equal(writePayloads[0].probeType, "metro_status");
  assert.equal(writePayloads[0].manifestProbeError, "probe timeout");
  assert.equal(writePayloads[1].probeType, "dev_client_manifest");
});

test("deriveValidationOutcome promotes a successful retry without hiding the initial timeout", () => {
  assert.deepEqual(
    deriveValidationOutcome(
      {
        status: "dev_client_read_timeout",
        reason: "ui_dump_socket_timeout",
      },
      {
        status: "app_loaded",
        reason: "success_text_visible",
      },
    ),
    {
      status: "app_loaded_after_retry",
      reason: "retry_recovered_after_timeout",
    },
  );
});
