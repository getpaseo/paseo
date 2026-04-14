#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 8081;
const DEFAULT_HOST = "lan";
const DEFAULT_LAUNCH_HOST = "127.0.0.1";
const DEFAULT_APP_ID = "sh.paseo.debug";
const DEFAULT_SCHEME = "exp+voice-mobile";
const DEFAULT_SUCCESS_TEXT = "Welcome to Paseo";
const DEFAULT_WAIT_MS = 15000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
const DEFAULT_ADB_COMMAND_TIMEOUT_MS = 15000;
const DEFAULT_BUILD_WORKSPACE_DEPS_TIMEOUT_MS = 180000;
const DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS = 15000;
const HTTP_PROBE_TIMEOUT_MS = 2000;
const HTTP_MANIFEST_PROBE_TIMEOUT_MS = 20000;
const HTTP_PROBE_BODY_LIMIT = 32768;
const HTTP_CAPTURE_BODY_LIMIT = 65536;
const HTTP_REPLAY_TIMEOUT_MS = 15000;
const WORKSPACE_UI_MARKERS = [
  "workspace-header-title",
  "message-input-root",
  "agent-chat-scroll",
  "workspace-tabs-row",
  "workspace-open-in-editor-primary",
  "permission-request-question",
];
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);
const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
];

function printHelp() {
  console.log(`Usage: node packages/app/scripts/windows-dev-client-validation.cjs [options]

Options:
  --port <number>                 Expo dev server port (default: ${DEFAULT_PORT})
  --host <lan|localhost|tunnel>   Expo host mode (default: ${DEFAULT_HOST})
  --launch-host <host>            Host embedded in the dev-client deep link (default: ${DEFAULT_LAUNCH_HOST})
  --device-id <id>                Optional adb device id
  --app-id <id>                   Android package id (default: ${DEFAULT_APP_ID})
  --scheme <scheme>               Expo dev-client scheme (default: ${DEFAULT_SCHEME})
  --output-dir <path>             Artifact directory (default: temp dir)
  --wait-ms <number>              Delay after launch before collecting evidence
  --startup-timeout-ms <number>   Expo readiness timeout
  --success-text <text>           UI text that indicates a successful app boot
  --env KEY=VALUE                 Additional environment override (repeatable)
  --capture-first-request         Put an HTTP capture proxy in front of Metro and record the first requests
  --retry-on-timeout              Relaunch once if the first attempt hits the Expo timeout screen
  --keep-proxy-env                Do not clear proxy env vars for Expo
  --skip-build-workspace-deps     Skip npm run build:workspace-deps
  --skip-adb-reverse              Skip adb reverse tcp:<port> tcp:<port>
  --skip-screenshot               Skip adb screencap capture
  --skip-ui-dump                  Skip adb uiautomator dump capture
  --skip-clear-logcat             Skip adb logcat -c before launch
  --help                          Print this help
`);
}

function parsePositiveInteger(label, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive integer, received: ${value}`);
  }
  return parsed;
}

function parseEnvAssignment(value) {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error(`Expected KEY=VALUE for --env, received: ${value}`);
  }

  return {
    key: value.slice(0, separatorIndex),
    value: value.slice(separatorIndex + 1),
  };
}

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    launchHost: DEFAULT_LAUNCH_HOST,
    deviceId: null,
    appId: DEFAULT_APP_ID,
    scheme: DEFAULT_SCHEME,
    outputDir: null,
    waitMs: DEFAULT_WAIT_MS,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    successText: DEFAULT_SUCCESS_TEXT,
    envOverrides: {},
    keepProxyEnv: false,
    buildWorkspaceDeps: true,
    adbReverse: true,
    captureScreenshot: true,
    captureUiDump: true,
    clearLogcat: true,
    help: false,
    captureFirstRequest: false,
    retryOnTimeout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--port":
        options.port = parsePositiveInteger("--port", argv[++index]);
        break;
      case "--host":
        options.host = argv[++index];
        break;
      case "--launch-host":
        options.launchHost = argv[++index];
        break;
      case "--device-id":
        options.deviceId = argv[++index];
        break;
      case "--app-id":
        options.appId = argv[++index];
        break;
      case "--scheme":
        options.scheme = argv[++index];
        break;
      case "--output-dir":
        options.outputDir = argv[++index];
        break;
      case "--wait-ms":
        options.waitMs = parsePositiveInteger("--wait-ms", argv[++index]);
        break;
      case "--startup-timeout-ms":
        options.startupTimeoutMs = parsePositiveInteger("--startup-timeout-ms", argv[++index]);
        break;
      case "--success-text":
        options.successText = argv[++index];
        break;
      case "--env": {
        const assignment = parseEnvAssignment(argv[++index]);
        options.envOverrides[assignment.key] = assignment.value;
        break;
      }
      case "--keep-proxy-env":
        options.keepProxyEnv = true;
        break;
      case "--capture-first-request":
        options.captureFirstRequest = true;
        break;
      case "--retry-on-timeout":
        options.retryOnTimeout = true;
        break;
      case "--skip-build-workspace-deps":
        options.buildWorkspaceDeps = false;
        break;
      case "--skip-adb-reverse":
        options.adbReverse = false;
        break;
      case "--skip-screenshot":
        options.captureScreenshot = false;
        break;
      case "--skip-ui-dump":
        options.captureUiDump = false;
        break;
      case "--skip-clear-logcat":
        options.clearLogcat = false;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }

    if (argument.startsWith("--") && index >= argv.length) {
      throw new Error(`Missing value for ${argument}`);
    }
  }

  if (!["lan", "localhost", "tunnel"].includes(options.host)) {
    throw new Error(`Unsupported Expo host mode: ${options.host}`);
  }

  return options;
}

function buildDeepLinkUrl({ scheme, launchHost, port }) {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(
    `http://${launchHost}:${port}`,
  )}`;
}

function uniqueCsv(values) {
  return [...new Set(values.filter(Boolean))].join(",");
}

function buildExpoEnv(baseEnv, options) {
  const env = { ...baseEnv };

  if (!options.keepProxyEnv) {
    for (const proxyKey of PROXY_ENV_KEYS) {
      delete env[proxyKey];
    }
  }

  const nextNoProxy = uniqueCsv([
    ...String(env.NO_PROXY ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    "localhost",
    "127.0.0.1",
  ]);

  env.NO_PROXY = nextNoProxy;
  env.no_proxy = nextNoProxy;

  for (const [key, value] of Object.entries(options.envOverrides ?? {})) {
    env[key] = value;
  }

  return env;
}

function hasVisibleWorkspaceUi(uiDumpXml) {
  const xml = String(uiDumpXml ?? "");
  let matchedMarkers = 0;

  for (const marker of WORKSPACE_UI_MARKERS) {
    if (xml.includes(marker)) {
      matchedMarkers += 1;
    }
  }

  return matchedMarkers >= 2;
}

function classifyValidationResult({ uiDumpXml, logcatText, launchOutput, successText }) {
  const uiXml = String(uiDumpXml ?? "");
  const deviceLogcat = String(logcatText ?? "");
  const launchText = String(launchOutput ?? "");

  if (successText && uiXml.includes(successText)) {
    return {
      status: "app_loaded",
      reason: "success_text_visible",
    };
  }

  if (
    /There was a problem loading the project\./i.test(uiXml) &&
    /SocketTimeoutException|Read timed out|timeout waiting for response headers/i.test(uiXml)
  ) {
    return {
      status: "dev_client_read_timeout",
      reason: "ui_dump_socket_timeout",
    };
  }

  if (hasVisibleWorkspaceUi(uiXml)) {
    return {
      status: "app_loaded",
      reason: "workspace_ui_visible",
    };
  }

  if (
    /SocketTimeoutException|Read timed out|timeout waiting for response headers/i.test(
      deviceLogcat,
    ) &&
    /sh\.paseo(?:\.debug)?|DevLauncherErrorActivity|expo\.modules\.devlauncher/i.test(deviceLogcat)
  ) {
    return {
      status: "dev_client_read_timeout",
      reason: "logcat_socket_timeout",
    };
  }

  if (/Activity not started|Error: Activity class|unable to resolve Intent/i.test(launchText)) {
    return {
      status: "launch_failed",
      reason: "adb_launch_error",
    };
  }

  return {
    status: "unknown",
    reason: "no_success_or_failure_signature",
  };
}

function inferRepoRoot() {
  return path.resolve(__dirname, "../../..");
}

function resolveNetworkPlan(options) {
  return {
    publicPort: options.port,
    metroPort: options.captureFirstRequest ? options.port + 1 : options.port,
  };
}

function resolveOutputDir(outputDir, now = new Date()) {
  if (outputDir) {
    return path.resolve(outputDir);
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(os.tmpdir(), "paseo-windows-dev-client-validation", timestamp);
}

function buildConfig(options, overrides = {}) {
  const repoRoot = overrides.repoRoot ?? inferRepoRoot();
  const appDir = overrides.appDir ?? path.join(repoRoot, "packages", "app");
  const outputDir = resolveOutputDir(options.outputDir, overrides.now);
  const networkPlan = resolveNetworkPlan(options);

  return {
    ...options,
    repoRoot,
    appDir,
    outputDir,
    publicPort: networkPlan.publicPort,
    metroPort: networkPlan.metroPort,
    deepLinkUrl: buildDeepLinkUrl({
      scheme: options.scheme,
      launchHost: options.launchHost,
      port: networkPlan.publicPort,
    }),
    expoEnv: buildExpoEnv(overrides.baseEnv ?? process.env, options),
    artifactPaths: {
      adbDevices: path.join(outputDir, "adb-devices.txt"),
      activityTop: path.join(outputDir, "activity-top.txt"),
      buildWorkspaceDeps: path.join(outputDir, "build-workspace-deps.log"),
      expoLog: path.join(outputDir, "expo.log"),
      expoProbe: path.join(outputDir, "expo-probe.json"),
      launch: path.join(outputDir, "adb-start.txt"),
      logcat: path.join(outputDir, "logcat.txt"),
      requestCapture: path.join(outputDir, "request-capture.json"),
      requestReplay: path.join(outputDir, "request-replay.json"),
      retryLaunch: path.join(outputDir, "adb-start-retry.txt"),
      retryActivityTop: path.join(outputDir, "activity-top-retry.txt"),
      retryLogcat: path.join(outputDir, "logcat-retry.txt"),
      retryScreenshot: path.join(outputDir, "device-retry.png"),
      retryUiDump: path.join(outputDir, "device-retry.xml"),
      screenshot: path.join(outputDir, "device-loaded.png"),
      summary: path.join(outputDir, "summary.json"),
      uiDump: path.join(outputDir, "device-ui.xml"),
    },
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextFile(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, "utf8");
}

function writeJsonFile(filePath, value) {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildValidationSummary(config, summary) {
  return {
    outputDir: config.outputDir,
    port: config.publicPort,
    metroPort: config.metroPort,
    host: config.host,
    launchHost: config.launchHost,
    appId: config.appId,
    scheme: config.scheme,
    deepLinkUrl: config.deepLinkUrl,
    buildWorkspaceDeps: config.buildWorkspaceDeps,
    adbReverse: config.adbReverse,
    captureScreenshot: config.captureScreenshot,
    captureUiDump: config.captureUiDump,
    clearLogcat: config.clearLogcat,
    captureFirstRequest: config.captureFirstRequest,
    retryOnTimeout: config.retryOnTimeout,
    envOverrides: config.envOverrides,
    ...summary,
  };
}

function createCommandTimeoutError({ command, args, timeoutMs, stdout = "", stderr = "" }) {
  const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
  error.code = "COMMAND_TIMEOUT";
  error.timedOut = true;
  error.command = command;
  error.args = [...args];
  error.timeoutMs = timeoutMs;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function createCommandExitError({ command, args, exitCode, stdout = "", stderr = "" }) {
  const error = new Error(
    `${command} ${args.join(" ")} exited with code ${exitCode}\n${stdout}${stderr}`,
  );
  error.code = "COMMAND_EXIT";
  error.command = command;
  error.args = [...args];
  error.commandExitCode = exitCode;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function failureArtifactPathForPhase(config, phase) {
  switch (phase) {
    case "adb_devices":
      return config.artifactPaths.adbDevices;
    case "build_workspace_deps":
      return config.artifactPaths.buildWorkspaceDeps;
    case "launch_app":
      return config.artifactPaths.launch;
    case "retry_launch":
      return config.artifactPaths.retryLaunch;
    default:
      return null;
  }
}

function terminateChildProcess(child, platform = process.platform) {
  return new Promise((resolve) => {
    if (!child?.pid || child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    if (platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
      return;
    }

    child.kill("SIGKILL");
    resolve();
  });
}

function shellCommandName(command, platform = process.platform) {
  if (platform === "win32" && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }
  return command;
}

function buildSpawnInvocation(command, args, platform = process.platform) {
  const resolvedCommand = shellCommandName(command, platform);

  if (platform === "win32" && resolvedCommand.endsWith(".cmd")) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", resolvedCommand, ...args],
    };
  }

  return {
    command: resolvedCommand,
    args,
  };
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const invocation = buildSpawnInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timeoutHandle = null;

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      callback();
    };

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      settle(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0 && !options.allowFailure) {
          reject(
            createCommandExitError({
              command,
              args,
              exitCode: code,
              stdout,
              stderr,
            }),
          );
          return;
        }

        resolve({
          code,
          stdout,
          stderr,
        });
      });
    });

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const timeoutError = createCommandTimeoutError({
          command,
          args,
          timeoutMs: options.timeoutMs,
          stdout,
          stderr,
        });
        terminateChildProcess(child).finally(() => {
          settle(() => reject(timeoutError));
        });
      }, options.timeoutMs);

      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    }
  });
}

function captureBinaryToFile(command, args, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(outputPath));
    const file = fs.createWriteStream(outputPath);
    const invocation = buildSpawnInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks = [];
    let settled = false;
    let timeoutHandle = null;

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      callback();
    };

    child.stdout.pipe(file);
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      settle(() => {
        file.destroy();
        reject(error);
      });
    });
    child.on("close", (code) => {
      settle(() => {
        file.end();
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(
            createCommandExitError({
              command,
              args,
              exitCode: code,
              stderr,
            }),
          );
          return;
        }
        resolve({
          code,
          stderr,
        });
      });
    });

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const timeoutError = createCommandTimeoutError({
          command,
          args,
          timeoutMs: options.timeoutMs,
          stderr,
        });
        terminateChildProcess(child).finally(() => {
          settle(() => {
            file.destroy();
            reject(timeoutError);
          });
        });
      }, options.timeoutMs);

      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeRequest(requestOptions) {
  const options =
    typeof requestOptions === "string"
      ? {
          url: requestOptions,
          method: "GET",
        }
      : {
          method: "GET",
          ...requestOptions,
        };
  const timeoutMs = options.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const request = http.request(
      options.url,
      {
        method: options.method,
        headers: options.headers,
        timeout: timeoutMs,
      },
      (response) => {
        if (String(options.method ?? "GET").toUpperCase() === "HEAD") {
          response.resume();
          resolve({
            ok: true,
            statusCode: response.statusCode ?? null,
            headers: response.headers,
            bodyPreview: "",
          });
          return;
        }
        const bodyChunks = [];
        let bodyLength = 0;
        response.on("data", (chunk) => {
          if (bodyLength >= HTTP_PROBE_BODY_LIMIT) {
            return;
          }
          const buffer = Buffer.from(chunk);
          bodyLength += buffer.length;
          bodyChunks.push(buffer.slice(0, Math.max(0, HTTP_PROBE_BODY_LIMIT - bodyLength)));
        });
        response.on("end", () => {
          resolve({
            ok: true,
            statusCode: response.statusCode ?? null,
            headers: response.headers,
            bodyPreview: Buffer.concat(bodyChunks).toString("utf8"),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out probing ${options.url}`));
    });
    request.on("error", reject);
    request.end();
  });
}

function probeHttp(url) {
  return probeRequest({ url });
}

function cloneHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
}

function summarizeBuffer(buffer) {
  return buffer.subarray(0, HTTP_CAPTURE_BODY_LIMIT).toString("utf8");
}

function deriveValidationOutcome(initialClassification, retryClassification) {
  if (
    initialClassification.status === "dev_client_read_timeout" &&
    retryClassification?.status === "app_loaded"
  ) {
    return {
      status: "app_loaded_after_retry",
      reason: "retry_recovered_after_timeout",
    };
  }

  return initialClassification;
}

function buildUpstreamRequestHeaders(headers, config) {
  const nextHeaders = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalizedKey = String(key).toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(normalizedKey)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    nextHeaders[normalizedKey] = value;
  }

  nextHeaders.host = `127.0.0.1:${config.metroPort}`;
  return nextHeaders;
}

function shouldEndUpstreamImmediately({ method, headers }) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(normalizedMethod)) {
    return false;
  }

  const requestHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  );

  return !requestHeaders["content-length"] && !requestHeaders["transfer-encoding"];
}

function buildDevClientProbeHeaders(config) {
  return {
    host: `127.0.0.1:${config.metroPort}`,
    "expo-platform": "android",
    accept: "application/expo+json,application/json",
    "user-agent": "paseo-validation-probe",
  };
}

function isExpoManifestResponse(probeResult) {
  return /application\/expo\+json/i.test(String(probeResult?.headers?.["content-type"] ?? ""));
}

function isMetroStatusResponse(probeResult) {
  return (
    Number(probeResult?.statusCode) === 200 &&
    /packager-status:running/i.test(String(probeResult?.bodyPreview ?? ""))
  );
}

function rewriteExpoManifestResponse(headers, bodyText, config) {
  const contentType = String(headers?.["content-type"] ?? "");
  if (!/(application\/expo\+json|multipart\/mixed)/i.test(contentType)) {
    return {
      rewritten: false,
      headers,
      bodyText,
    };
  }

  const upstreamHost = `127.0.0.1:${config.metroPort}`;
  const publicHost = `127.0.0.1:${config.publicPort}`;
  if (!String(bodyText).includes(upstreamHost)) {
    return {
      rewritten: false,
      headers,
      bodyText,
    };
  }

  const rewrittenBody = String(bodyText).split(upstreamHost).join(publicHost);
  return {
    rewritten: true,
    headers: {
      ...headers,
      "content-length": String(Buffer.byteLength(rewrittenBody)),
    },
    bodyText: rewrittenBody,
  };
}

function startRequestCaptureProxy(config) {
  if (!config.captureFirstRequest) {
    return null;
  }

  const entries = [];
  const server = http.createServer((request, response) => {
    const entry = {
      id: entries.length + 1,
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: cloneHeaders(request.headers),
      startedAt: new Date().toISOString(),
      requestBodyPreview: "",
      requestBodyBytes: 0,
      responseBodyPreview: "",
      responseBodyBytes: 0,
      clientAborted: false,
    };
    entries.push(entry);

    const requestChunks = [];
    request.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      entry.requestBodyBytes += buffer.length;
      if (Buffer.concat(requestChunks).length < HTTP_CAPTURE_BODY_LIMIT) {
        requestChunks.push(buffer);
      }
    });
    request.on("aborted", () => {
      entry.clientAborted = true;
    });

    let upstreamEnded = false;
    const upstreamRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: config.metroPort,
        method: request.method,
        path: request.url,
        headers: buildUpstreamRequestHeaders(request.headers, config),
      },
      (upstreamResponse) => {
        entry.responseStatusCode = upstreamResponse.statusCode ?? null;
        const responseHeaders = cloneHeaders(upstreamResponse.headers);
        entry.responseHeaders = responseHeaders;
        if (String(request.method ?? "GET").toUpperCase() === "HEAD") {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.resume();
          response.end();
          entry.completedAt = new Date().toISOString();
          return;
        }

        const responseChunks = [];
        upstreamResponse.on("data", (chunk) => {
          responseChunks.push(Buffer.from(chunk));
        });
        upstreamResponse.on("end", () => {
          const upstreamBody = Buffer.concat(responseChunks).toString("utf8");
          const rewrittenResponse = rewriteExpoManifestResponse(
            responseHeaders,
            upstreamBody,
            config,
          );
          const responseBodyBuffer = Buffer.from(rewrittenResponse.bodyText, "utf8");
          entry.responseHeaders = rewrittenResponse.headers;
          entry.responseBodyBytes = responseBodyBuffer.length;
          entry.responseBodyPreview = summarizeBuffer(responseBodyBuffer);
          response.writeHead(upstreamResponse.statusCode ?? 502, rewrittenResponse.headers);
          response.end(responseBodyBuffer);
          entry.completedAt = new Date().toISOString();
        });
      },
    );
    upstreamRequest.setTimeout(HTTP_REPLAY_TIMEOUT_MS);

    upstreamRequest.on("timeout", () => {
      entry.upstreamError = "upstream_request_timeout";
      upstreamRequest.destroy(new Error("Upstream request timed out"));
    });
    upstreamRequest.on("error", (error) => {
      entry.upstreamError = String(error.message ?? error);
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end(`Proxy upstream error: ${entry.upstreamError}`);
      entry.completedAt = new Date().toISOString();
    });

    const finishUpstreamRequest = () => {
      if (upstreamEnded) {
        return;
      }
      upstreamEnded = true;
      entry.requestBodyPreview = summarizeBuffer(Buffer.concat(requestChunks));
      const requestBody = Buffer.concat(requestChunks);
      if (requestBody.length > 0) {
        upstreamRequest.end(requestBody);
        return;
      }
      upstreamRequest.end();
    };

    request.on("end", () => {
      finishUpstreamRequest();
    });
    request.on("error", (error) => {
      entry.upstreamError = String(error.message ?? error);
      upstreamRequest.destroy(error);
    });

    if (shouldEndUpstreamImmediately({ method: request.method, headers: request.headers })) {
      request.resume();
      finishUpstreamRequest();
    }
  });

  return {
    entries,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.publicPort, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async stop() {
      writeJsonFile(config.artifactPaths.requestCapture, {
        publicPort: config.publicPort,
        metroPort: config.metroPort,
        entries,
      });
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function replayCapturedRequest(config, entry) {
  return new Promise((resolve) => {
    if (!entry) {
      resolve({
        ok: false,
        skipped: true,
        reason: "no_captured_request",
      });
      return;
    }

    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: config.metroPort,
        method: entry.method,
        path: entry.url,
        headers: buildUpstreamRequestHeaders(entry.headers, config),
        timeout: HTTP_REPLAY_TIMEOUT_MS,
      },
      (response) => {
        const resolvedHeaders = cloneHeaders(response.headers);
        if (String(entry.method ?? "GET").toUpperCase() === "HEAD") {
          response.resume();
          resolve({
            ok: true,
            statusCode: response.statusCode ?? null,
            headers: resolvedHeaders,
            bodyPreview: "",
          });
          return;
        }
        const bodyChunks = [];
        let bodyLength = 0;
        response.on("data", (chunk) => {
          const buffer = Buffer.from(chunk);
          bodyLength += buffer.length;
          if (bodyLength <= HTTP_CAPTURE_BODY_LIMIT) {
            bodyChunks.push(buffer);
          }
        });
        response.on("end", () => {
          resolve({
            ok: true,
            statusCode: response.statusCode ?? null,
            headers: resolvedHeaders,
            bodyPreview: summarizeBuffer(Buffer.concat(bodyChunks)),
          });
        });
      },
    );
    request.setTimeout(HTTP_REPLAY_TIMEOUT_MS);

    request.on("timeout", () => {
      request.destroy(new Error("Replay request timed out"));
    });
    request.on("error", (error) => {
      resolve({
        ok: false,
        error: String(error.message ?? error),
      });
    });
    request.end(entry.requestBodyPreview);
  });
}

function startExpoProcess(config) {
  ensureDir(path.dirname(config.artifactPaths.expoLog));
  const logStream = fs.createWriteStream(config.artifactPaths.expoLog);
  const invocation = buildSpawnInvocation("npx", [
    "expo",
    "start",
    "--dev-client",
    "--host",
    config.host,
    "--port",
    String(config.metroPort),
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: config.appDir,
    env: config.expoEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let combinedOutput = "";
  const onChunk = (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    combinedOutput += text;
    logStream.write(text);
    process.stdout.write(text);
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  return {
    child,
    getOutput() {
      return combinedOutput;
    },
    async stop() {
      if (child.exitCode !== null || child.killed) {
        logStream.end();
        return;
      }

      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (child.exitCode === null) {
        if (process.platform === "win32") {
          await spawnCapture("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            allowFailure: true,
          });
        } else {
          child.kill("SIGKILL");
        }
      }

      logStream.end();
    },
  };
}

async function waitForExpoReady(config, expoProcess, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const sleepFn = dependencies.sleep ?? sleep;
  const probe = dependencies.probe ?? probeRequest;
  const writeJson = dependencies.writeJson ?? ((filePath, value) => writeJsonFile(filePath, value));
  const getOutput = dependencies.getOutput ?? (() => expoProcess.getOutput());
  const startedAt = now();
  const probeUrl = `http://127.0.0.1:${config.metroPort}`;
  let metroStatusReadyProbe = null;

  while (now() - startedAt < config.startupTimeoutMs) {
    if (expoProcess.child.exitCode !== null) {
      throw new Error("Expo process exited before it became ready");
    }

    const waitingBannerObserved = /Waiting on http:\/\/localhost:|Logs for your project/i.test(
      getOutput(),
    );

    let lastProbeError = null;
    let lastNonManifestProbe = null;
    let lastManifestProbeError = null;

    try {
      const statusProbeResult = await probe({
        probeType: "metro_status",
        url: `${probeUrl}/status`,
      });

      if (isMetroStatusResponse(statusProbeResult)) {
        metroStatusReadyProbe = statusProbeResult;
      } else {
        lastNonManifestProbe = {
          probeType: "metro_status",
          ...statusProbeResult,
        };
      }
    } catch (error) {
      lastProbeError = error;
    }

    if (metroStatusReadyProbe) {
      try {
        const manifestProbeResult = await probe({
          probeType: "dev_client_manifest",
          url: probeUrl,
          method: "HEAD",
          headers: buildDevClientProbeHeaders(config),
          timeoutMs: HTTP_MANIFEST_PROBE_TIMEOUT_MS,
        });

        if (isExpoManifestResponse(manifestProbeResult)) {
          writeJson(config.artifactPaths.expoProbe, {
            url: probeUrl,
            probeType: "dev_client_manifest",
            waitingBannerObserved,
            ...manifestProbeResult,
          });
          return manifestProbeResult;
        }

        lastNonManifestProbe = {
          probeType: "dev_client_manifest",
          ...manifestProbeResult,
        };
      } catch (error) {
        lastManifestProbeError = error;
      }

      writeJson(config.artifactPaths.expoProbe, {
        url: probeUrl,
        probeType: "metro_status",
        waitingBannerObserved,
        ...metroStatusReadyProbe,
        manifestProbeError: String(
          lastManifestProbeError?.message ??
            lastManifestProbeError ??
            "dev-client manifest probe pending",
        ),
      });
      await sleepFn(1500);
      continue;
    }

    writeJson(config.artifactPaths.expoProbe, {
      url: probeUrl,
      waitingBannerObserved,
      ...(lastNonManifestProbe ?? {
        probeType: "pending",
        ok: false,
      }),
      probeError: String(lastProbeError?.message ?? lastProbeError ?? "probe failed"),
    });

    await sleepFn(1500);
  }

  throw new Error(`Timed out waiting for Expo on port ${config.port}`);
}

async function captureDeviceState(config, adbPrefix, artifactPaths) {
  let uiDumpXml = "";

  if (artifactPaths.screenshot && config.captureScreenshot) {
    await captureBinaryToFile(
      "adb",
      [...adbPrefix, "exec-out", "screencap", "-p"],
      artifactPaths.screenshot,
      {
        timeoutMs: DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS,
      },
    );
  }

  if (artifactPaths.uiDump && config.captureUiDump) {
    const remoteUiDumpPath = `/sdcard/paseo-dev-client-validation-${path.basename(artifactPaths.uiDump)}`;
    await spawnCapture("adb", [...adbPrefix, "shell", "uiautomator", "dump", remoteUiDumpPath], {
      timeoutMs: DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS,
    });
    await spawnCapture("adb", [...adbPrefix, "pull", remoteUiDumpPath, artifactPaths.uiDump], {
      timeoutMs: DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS,
    });
    uiDumpXml = fs.readFileSync(artifactPaths.uiDump, "utf8");
  }

  const activityTop = await spawnCapture(
    "adb",
    [...adbPrefix, "shell", "dumpsys", "activity", "top"],
    {
      timeoutMs: DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS,
    },
  );
  writeTextFile(artifactPaths.activityTop, `${activityTop.stdout}${activityTop.stderr}`);

  const logcat = await spawnCapture("adb", [...adbPrefix, "logcat", "-d", "-v", "time"], {
    allowFailure: true,
    timeoutMs: DEFAULT_DEVICE_CAPTURE_TIMEOUT_MS,
  });
  const logcatText = `${logcat.stdout}${logcat.stderr}`;
  writeTextFile(artifactPaths.logcat, logcatText);

  return {
    uiDumpXml,
    logcatText,
  };
}

async function runValidation(config, dependencies = {}) {
  const spawnCaptureFn = dependencies.spawnCapture ?? spawnCapture;
  const startRequestCaptureProxyFn =
    dependencies.startRequestCaptureProxy ?? startRequestCaptureProxy;
  const startExpoProcessFn = dependencies.startExpoProcess ?? startExpoProcess;
  const waitForExpoReadyFn = dependencies.waitForExpoReady ?? waitForExpoReady;
  const captureDeviceStateFn = dependencies.captureDeviceState ?? captureDeviceState;
  ensureDir(config.outputDir);
  let currentPhase = "starting";
  const writeSummary = (summary) =>
    writeJsonFile(config.artifactPaths.summary, buildValidationSummary(config, summary));
  const setPhase = (phase, extra = {}) => {
    currentPhase = phase;
    writeSummary({
      phase,
      ...extra,
    });
  };

  setPhase("starting");

  const adbPrefix = config.deviceId ? ["-s", config.deviceId] : [];
  let requestProxy = null;
  let expoProcess = null;
  let launchResult = "";
  let initialClassification = {
    status: "unknown",
    reason: "validation_interrupted",
  };
  let retrySummary = null;
  let replaySummary = null;

  try {
    setPhase("adb_devices");
    const adbDevices = await spawnCaptureFn("adb", ["devices"], {
      timeoutMs: DEFAULT_ADB_COMMAND_TIMEOUT_MS,
    });
    writeTextFile(config.artifactPaths.adbDevices, `${adbDevices.stdout}${adbDevices.stderr}`);

    if (config.buildWorkspaceDeps) {
      setPhase("build_workspace_deps");
      const buildResult = await spawnCaptureFn("npm", ["run", "build:workspace-deps"], {
        cwd: config.appDir,
        env: config.expoEnv,
        timeoutMs: DEFAULT_BUILD_WORKSPACE_DEPS_TIMEOUT_MS,
      });
      writeTextFile(
        config.artifactPaths.buildWorkspaceDeps,
        `${buildResult.stdout}${buildResult.stderr}`,
      );
    }

    if (config.clearLogcat) {
      setPhase("clear_logcat");
      await spawnCaptureFn("adb", [...adbPrefix, "logcat", "-c"], {
        allowFailure: true,
        timeoutMs: DEFAULT_ADB_COMMAND_TIMEOUT_MS,
      });
    }

    setPhase("start_request_capture");
    requestProxy = startRequestCaptureProxyFn(config);
    if (requestProxy) {
      await requestProxy.start();
    }

    setPhase("start_expo");
    expoProcess = startExpoProcessFn(config);

    setPhase("wait_for_expo");
    await waitForExpoReadyFn(config, expoProcess);

    if (config.adbReverse) {
      setPhase("adb_reverse");
      const reverseResult = await spawnCaptureFn(
        "adb",
        [...adbPrefix, "reverse", `tcp:${config.publicPort}`, `tcp:${config.publicPort}`],
        {
          timeoutMs: DEFAULT_ADB_COMMAND_TIMEOUT_MS,
        },
      );
      writeTextFile(
        path.join(config.outputDir, "adb-reverse.txt"),
        `${reverseResult.stdout}${reverseResult.stderr}`,
      );
    }

    setPhase("launch_app");
    const launch = await spawnCaptureFn(
      "adb",
      [
        ...adbPrefix,
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        config.deepLinkUrl,
        config.appId,
      ],
      {
        timeoutMs: DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS,
      },
    );
    launchResult = `${launch.stdout}${launch.stderr}`;
    writeTextFile(config.artifactPaths.launch, launchResult);

    setPhase("wait_for_app");
    await sleep(config.waitMs);

    setPhase("capture_device_state");
    const initialState = await captureDeviceStateFn(config, adbPrefix, {
      activityTop: config.artifactPaths.activityTop,
      screenshot: config.artifactPaths.screenshot,
      uiDump: config.artifactPaths.uiDump,
      logcat: config.artifactPaths.logcat,
    });

    initialClassification = classifyValidationResult({
      uiDumpXml: initialState.uiDumpXml,
      logcatText: initialState.logcatText,
      launchOutput: launchResult,
      successText: config.successText,
    });

    if (requestProxy) {
      setPhase("replay_captured_request");
      replaySummary = await replayCapturedRequest(config, requestProxy.entries[0]);
      writeJsonFile(config.artifactPaths.requestReplay, replaySummary);
    }

    if (config.retryOnTimeout && initialClassification.status === "dev_client_read_timeout") {
      setPhase("retry_launch");
      const retryLaunch = await spawnCaptureFn(
        "adb",
        [
          ...adbPrefix,
          "shell",
          "am",
          "start",
          "-W",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          config.deepLinkUrl,
          config.appId,
        ],
        {
          timeoutMs: DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS,
        },
      );
      const retryLaunchText = `${retryLaunch.stdout}${retryLaunch.stderr}`;
      writeTextFile(config.artifactPaths.retryLaunch, retryLaunchText);

      setPhase("wait_for_retry");
      await sleep(config.waitMs);

      setPhase("capture_retry_device_state");
      const retryState = await captureDeviceStateFn(config, adbPrefix, {
        activityTop: config.artifactPaths.retryActivityTop,
        screenshot: config.artifactPaths.retryScreenshot,
        uiDump: config.artifactPaths.retryUiDump,
        logcat: config.artifactPaths.retryLogcat,
      });
      const retryClassification = classifyValidationResult({
        uiDumpXml: retryState.uiDumpXml,
        logcatText: retryState.logcatText,
        launchOutput: retryLaunchText,
        successText: config.successText,
      });

      retrySummary = {
        launch: retryLaunchText,
        ...retryClassification,
      };
    }

    const finalOutcome = deriveValidationOutcome(initialClassification, retrySummary);

    const summary = {
      phase: "completed",
      status: finalOutcome.status,
      reason: finalOutcome.reason,
      outputDir: config.outputDir,
      port: config.publicPort,
      metroPort: config.metroPort,
      host: config.host,
      launchHost: config.launchHost,
      appId: config.appId,
      scheme: config.scheme,
      deepLinkUrl: config.deepLinkUrl,
      artifactPaths: config.artifactPaths,
      initial: {
        launch: launchResult,
        ...initialClassification,
      },
      replay: replaySummary,
      retry: retrySummary,
    };
    writeSummary(summary);
    return summary;
  } catch (error) {
    const failureArtifactPath = failureArtifactPathForPhase(config, currentPhase);
    if (failureArtifactPath && (error?.stdout || error?.stderr)) {
      writeTextFile(failureArtifactPath, `${error.stdout ?? ""}${error.stderr ?? ""}`);
    }

    const summary = {
      phase: "completed",
      status: error?.timedOut ? "command_timeout" : "validation_failed",
      reason: error?.timedOut ? `${currentPhase}_timeout` : `${currentPhase}_failed`,
      failedPhase: currentPhase,
      artifactPaths: config.artifactPaths,
      error: String(error?.stack || error?.message || error),
      failedCommand: error?.command
        ? {
            command: error.command,
            args: error.args,
            exitCode: error.commandExitCode ?? null,
            timeoutMs: error.timeoutMs ?? null,
          }
        : null,
      timedOutCommand: error?.timedOut
        ? {
            command: error.command,
            args: error.args,
            timeoutMs: error.timeoutMs,
          }
        : null,
    };
    writeSummary(summary);
    return buildValidationSummary(config, summary);
  } finally {
    if (requestProxy) {
      await requestProxy.stop();
    }
    if (expoProcess) {
      await expoProcess.stop();
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (process.platform !== "win32") {
    throw new Error("windows-dev-client-validation.cjs must run on Windows");
  }

  const config = buildConfig(options);
  console.log(`Artifacts: ${config.outputDir}`);
  console.log(`Deep link: ${config.deepLinkUrl}`);
  const summary = await runValidation(config);
  console.log(`Validation status: ${summary.status} (${summary.reason})`);

  if (summary.status === "app_loaded" || summary.status === "app_loaded_after_retry") {
    return;
  }

  process.exitCode =
    summary.status === "dev_client_read_timeout" ? 2 : summary.status === "launch_failed" ? 3 : 4;
}

module.exports = {
  buildSpawnInvocation,
  buildUpstreamRequestHeaders,
  buildConfig,
  buildDeepLinkUrl,
  buildExpoEnv,
  classifyValidationResult,
  deriveValidationOutcome,
  parseArgs,
  rewriteExpoManifestResponse,
  waitForExpoReady,
  shouldEndUpstreamImmediately,
  spawnCapture,
  runValidation,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
