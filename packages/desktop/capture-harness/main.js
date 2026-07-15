const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, nativeImage, screen, session } = require("electron");

const ROOT = __dirname;
const OUT_DIR = process.env.PASEO_CAPTURE_HARNESS_OUT_DIR || path.join(ROOT, "out");
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const FULL_PAGE_HEIGHT = 1600;
const CAPTURE_TIMEOUT_MS = 5000;
const BROWSER_PROFILE_TIMEOUT_MS = 15000;
const CAPTURE_RETRY_INTERVAL_MS = 200;
const REPEAT_COUNT = 5;
const FRESH_REPEAT_COUNT = 3;
const SOAK_MS = Number(process.env.PASEO_CAPTURE_HARNESS_SOAK_MS || 75000);
const HARNESS_GROUP = process.env.PASEO_CAPTURE_HARNESS_GROUP || "permanent-parking";
const BROWSER_PROFILE_PHASE = process.env.PASEO_CAPTURE_HARNESS_PHASE || "";
const BROWSER_PROFILE_ORIGIN_FILE = path.join(OUT_DIR, "browser-profile-origin.txt");
const BROWSER_PROFILE_VALUE_FILE = path.join(OUT_DIR, "browser-profile-value.txt");
const PERMANENT_STATE_FILTER = new Set(
  (process.env.PASEO_CAPTURE_HARNESS_STATES || "P1")
    .split(",")
    .map((state) => state.trim())
    .filter(Boolean),
);
const PERMANENT_VARIANT_FILTER = new Set(
  (process.env.PASEO_CAPTURE_HARNESS_VARIANTS || "attach-off")
    .split(",")
    .map((variant) => variant.trim())
    .filter(Boolean),
);
const PERMANENT_CAPTURE_MODES = ["viewport", "full-page"];
const PERMANENT_THROTTLING_VARIANTS = [
  {
    id: "capture-only-throttling",
    code: "capture-only",
    label: "backgroundThrottling disabled only during each capture",
    disableGuestBackgroundThrottlingAtAttach: false,
  },
  {
    id: "attach-off-throttling",
    code: "attach-off",
    label: "backgroundThrottling disabled once at guest attach",
    disableGuestBackgroundThrottlingAtAttach: true,
  },
];
const ATTACH_OFF_VARIANT_STATE_CODES = new Set(["P1", "P3", "P7"]);
const PERMANENT_PARKING_STATES = [
  {
    id: "p1-overflow-1x1",
    code: "P1",
    label: "host 1x1 overflow hidden",
  },
  {
    id: "p2-clip-path-1x1",
    code: "P2",
    label: "host 1x1 clip-path inset 1px",
  },
  {
    id: "p3-opacity-0",
    code: "P3",
    label: "host full-size opacity 0",
  },
  {
    id: "p4-transform-scale-0",
    code: "P4a",
    label: "host full-size transform scale(0)",
  },
  {
    id: "p4-transform-scale-0001",
    code: "P4b",
    label: "host full-size transform scale(0.001)",
  },
  {
    id: "p5-webview-0x0",
    code: "P5a",
    label: "webview element 0x0",
  },
  {
    id: "p5-webview-1x1",
    code: "P5b",
    label: "webview element 1x1",
  },
  {
    id: "p6-z-index-negative",
    code: "P6",
    label: "host full-size z-index -1 behind page",
  },
  {
    id: "p7-opacity-001",
    code: "P7",
    label: "host full-size opacity 0.01",
  },
];

function applyEarlyMacHarnessActivationPolicy() {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    app.setActivationPolicy("accessory");
  } catch {
    // App readiness varies by Electron/macOS version; enforce again before windows.
  }
}

function applyMacHarnessActivationPolicyBeforeWindows() {
  if (process.platform !== "darwin") {
    return;
  }
  app.setActivationPolicy("accessory");
  app.dock?.hide();
}

applyEarlyMacHarnessActivationPolicy();

function fileUrl(filePath, params = {}) {
  const url = new URL(`file://${filePath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function startBrowserProfileServer() {
  let port = 0;
  if (BROWSER_PROFILE_PHASE === "read") {
    const previousOrigin = (await fsp.readFile(BROWSER_PROFILE_ORIGIN_FILE, "utf8")).trim();
    port = Number(new URL(previousOrigin).port);
  }

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Shared browser profile</title><h1>Profile fixture</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("browser profile fixture server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  if (BROWSER_PROFILE_PHASE === "write") {
    await fsp.writeFile(BROWSER_PROFILE_ORIGIN_FILE, `${origin}\n`);
  }
  return { origin, server };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cornerWindowBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const inset = 12;
  return {
    x: Math.round(workArea.x + workArea.width - width - inset),
    y: Math.round(workArea.y + workArea.height - height - inset),
    width,
    height,
  };
}

function createInactiveHarnessWindow(input) {
  const { width, height, ...options } = input;
  const win = new BrowserWindow({
    ...options,
    ...cornerWindowBounds(width, height),
    show: false,
    skipTaskbar: true,
  });
  const readyToShow = new Promise((resolve) => {
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.showInactive();
      }
      resolve();
    });
  });
  return { win, readyToShow };
}

async function waitForInactiveReveal(handle, label) {
  await withTimeout(handle.readyToShow, `${label} ready-to-show`);
  await delay(250);
}

function withTimeout(promise, label, timeoutMs = CAPTURE_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

function isBrightMagenta(bitmap, offset) {
  const c0 = bitmap[offset];
  const c1 = bitmap[offset + 1];
  const c2 = bitmap[offset + 2];
  return c0 > 200 && c1 < 90 && c2 > 200;
}

function analyzeImage(image, expected, guestMetrics) {
  if (!image || image.isEmpty()) {
    return {
      width: 0,
      height: 0,
      logicalWidthAtDpr: 0,
      logicalHeightAtDpr: 0,
      brightRatio: 0,
      textNonUniform: false,
      matchedSize: false,
      pass: false,
    };
  }

  const size = image.getSize();
  const width = size.width;
  const height = size.height;
  const bitmap = image.toBitmap();
  const totalPixels = width * height;
  let brightPixels = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (isBrightMagenta(bitmap, offset)) {
      brightPixels += 1;
    }
  }

  const crop = {
    left: Math.min(40, Math.max(0, width - 1)),
    top: Math.min(40, Math.max(0, height - 1)),
    right: Math.min(width, 940),
    bottom: Math.min(height, 260),
  };
  let cropPixels = 0;
  let cropNonBright = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  const quantized = new Set();
  for (let y = crop.top; y < crop.bottom; y += 1) {
    for (let x = crop.left; x < crop.right; x += 1) {
      const offset = pixelOffset(width, x, y);
      cropPixels += 1;
      if (!isBrightMagenta(bitmap, offset)) {
        cropNonBright += 1;
      }
      const r = bitmap[offset + 2];
      const g = bitmap[offset + 1];
      const b = bitmap[offset];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminanceSum += luma;
      luminanceSqSum += luma * luma;
      quantized.add(`${r >> 5},${g >> 5},${b >> 5},${bitmap[offset + 3] >> 6}`);
    }
  }

  const devicePixelRatio =
    typeof guestMetrics.devicePixelRatio === "number" && guestMetrics.devicePixelRatio > 0
      ? guestMetrics.devicePixelRatio
      : 1;
  const sizeTargets = [
    { width: expected.width, height: expected.height },
    {
      width: Math.round(expected.width * devicePixelRatio),
      height: Math.round(expected.height * devicePixelRatio),
    },
  ];
  const matchedSize = sizeTargets.some(
    (target) => Math.abs(width - target.width) <= 2 && Math.abs(height - target.height) <= 2,
  );
  const luminanceMean = cropPixels ? luminanceSum / cropPixels : 0;
  const luminanceVariance = cropPixels
    ? luminanceSqSum / cropPixels - luminanceMean * luminanceMean
    : 0;
  const brightRatio = totalPixels ? brightPixels / totalPixels : 0;
  const textNonUniform =
    cropPixels > 0 &&
    cropNonBright / cropPixels > 0.02 &&
    quantized.size >= 4 &&
    luminanceVariance > 100;

  return {
    width,
    height,
    logicalWidthAtDpr: width / devicePixelRatio,
    logicalHeightAtDpr: height / devicePixelRatio,
    brightRatio,
    textNonUniform,
    matchedSize,
    pass: matchedSize && brightRatio >= expected.minBrightRatio && textNonUniform,
  };
}

function expectedForMode(mode) {
  return mode === "viewport"
    ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
    : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
}

function summarizeAnalysis(analysis) {
  if (!analysis) {
    return {
      width: 0,
      height: 0,
      logicalWidthAtDpr: 0,
      logicalHeightAtDpr: 0,
      brightRatio: 0,
      textNonUniform: false,
      matchedSize: false,
      pass: false,
    };
  }
  return {
    width: analysis.width,
    height: analysis.height,
    logicalWidthAtDpr: analysis.logicalWidthAtDpr,
    logicalHeightAtDpr: analysis.logicalHeightAtDpr,
    brightRatio: analysis.brightRatio,
    textNonUniform: analysis.textNonUniform,
    matchedSize: analysis.matchedSize,
    pass: analysis.pass,
  };
}

function analysisSize(analysis) {
  if (!analysis) {
    return "0x0";
  }
  return `${analysis.width}x${analysis.height}`;
}

function analysisLogicalSize(analysis) {
  if (!analysis) {
    return "0x0";
  }
  return `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.log(`FAIL ${message}`);
  throw new Error(message);
}

async function saveImage(image, outputPath) {
  ensureDirSync(path.dirname(outputPath));
  await fsp.writeFile(outputPath, image.toPNG());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGuestLoad(contents, input = {}) {
  await new Promise((resolve) => {
    if (!contents.isLoading()) {
      resolve();
      return;
    }
    contents.once("did-finish-load", resolve);
    contents.once("did-fail-load", resolve);
  });
  const settleMs = input.settleMs ?? 500;
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

async function renderer(win, expression) {
  return await win.webContents.executeJavaScript(expression, true);
}

async function readGuestMetrics(contents) {
  return await contents.executeJavaScript(
    `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      visualViewport: window.visualViewport ? {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        scale: window.visualViewport.scale
      } : null
    })`,
    true,
  );
}

async function capturePageSequence(contents) {
  contents.invalidate();
  return await withTimeout(contents.capturePage(undefined, { stayHidden: false }), "capturePage");
}

async function captureFullPage(contents) {
  let attachedHere = false;
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
    attachedHere = true;
  }
  try {
    const metrics = await contents.debugger.sendCommand("Page.getLayoutMetrics");
    const contentSize = metrics.cssContentSize ||
      metrics.contentSize || {
        x: 0,
        y: 0,
        width: VIEWPORT_WIDTH,
        height: FULL_PAGE_HEIGHT,
      };
    const clip = {
      x: Math.floor(contentSize.x || 0),
      y: Math.floor(contentSize.y || 0),
      width: Math.ceil(contentSize.width || VIEWPORT_WIDTH),
      height: Math.ceil(contentSize.height || FULL_PAGE_HEIGHT),
      scale: 1,
    };
    const result = await withTimeout(
      contents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip,
      }),
      "CDP Page.captureScreenshot",
    );
    return nativeImage.createFromBuffer(Buffer.from(result.data, "base64"));
  } finally {
    if (attachedHere && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
  }
}

async function captureFullPageSequence(contents) {
  contents.invalidate();
  return await captureFullPage(contents);
}

function installHarnessWebviewGuards(win) {
  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
}

function trackAttachedGuests(win, input = {}) {
  const attachedGuests = [];
  const waiters = [];
  const countWaiters = [];
  win.webContents.on("did-attach-webview", (_event, contents) => {
    if (input.disableGuestBackgroundThrottlingAtAttach) {
      contents.setBackgroundThrottling(false);
    }
    attachedGuests.push(contents);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(contents);
    }
    for (let index = countWaiters.length - 1; index >= 0; index -= 1) {
      const countWaiter = countWaiters[index];
      if (attachedGuests.length >= countWaiter.count) {
        countWaiters.splice(index, 1);
        countWaiter.resolve(attachedGuests.slice(0, countWaiter.count));
      }
    }
  });
  return {
    attachedGuests,
    waitForNextAttachedGuest() {
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    waitForAttachedGuests(count) {
      if (attachedGuests.length >= count) {
        return Promise.resolve(attachedGuests.slice(0, count));
      }
      return new Promise((resolve) => {
        countWaiters.push({ count, resolve });
      });
    },
  };
}

async function createPermanentHarnessWindow(state, variant) {
  const handle = createInactiveHarnessWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, {
    disableGuestBackgroundThrottlingAtAttach: variant.disableGuestBackgroundThrottlingAtAttach,
  });
  await withTimeout(
    win.loadFile(path.join(ROOT, "index.html"), {
      query: {
        webviewCount: "0",
        permanentParkingState: state.id,
        targetUrl: fileUrl(path.join(ROOT, "bright.html")),
      },
    }),
    "permanent harness window loadFile",
  );
  await waitForInactiveReveal(handle, "permanent harness window");
  return { win, tracker };
}

async function createPermanentKeeperWindow() {
  const handle = createInactiveHarnessWindow({
    width: 1,
    height: 1,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  await withTimeout(win.loadURL("about:blank"), "permanent keeper loadURL");
  await waitForInactiveReveal(handle, "permanent keeper");
  return win;
}

async function closeHarnessWindow(win) {
  if (!win.isDestroyed()) {
    win.close();
  }
}

function targetUrlForVariant(state, variant, phase, mode, index) {
  const webviewNumber = index + 1;
  return fileUrl(path.join(ROOT, "bright.html"), {
    label: `${state.code} ${variant.code} ${phase.toUpperCase()} W${webviewNumber}`,
    sub: `${mode.toUpperCase()} ${state.id} ${variant.code}`,
    bottom: `${state.code} ${variant.code} FULL PAGE MARKER`,
  });
}

function variantsForPermanentState(state) {
  const defaultVariants = ATTACH_OFF_VARIANT_STATE_CODES.has(state.code)
    ? PERMANENT_THROTTLING_VARIANTS
    : [PERMANENT_THROTTLING_VARIANTS[0]];
  if (PERMANENT_VARIANT_FILTER.size === 0) {
    return defaultVariants;
  }
  return defaultVariants.filter(
    (variant) =>
      PERMANENT_VARIANT_FILTER.has(variant.id) || PERMANENT_VARIANT_FILTER.has(variant.code),
  );
}

async function appendPermanentWebview({ win, tracker, state, sourceUrl }) {
  const guestPromise = tracker.waitForNextAttachedGuest();
  const targetIndex = await withTimeout(
    renderer(
      win,
      `window.captureHarness.addPermanentWebview(${JSON.stringify(sourceUrl)}, ${JSON.stringify(state.id)})`,
    ),
    "permanent add webview",
  );
  const guest = await withTimeout(guestPromise, "permanent did-attach-webview");
  return { guest, targetIndex };
}

async function measurePermanentCapture({
  contents,
  mode,
  state,
  variant,
  phase,
  repeatIndex,
  repeatTotal,
  targetIndex,
  guestMetrics,
  retryUntilPass = false,
}) {
  const outputPath = path.join(
    OUT_DIR,
    "permanent-parking",
    variant.id,
    state.id,
    `${phase}-${mode}-webview-${targetIndex + 1}-${repeatIndex}.png`,
  );
  await fsp.rm(outputPath, { force: true });
  const expected = expectedForMode(mode);
  const start = Date.now();
  const deadline = start + CAPTURE_TIMEOUT_MS;
  let attempt = 0;
  let lastAnalysis = null;
  let lastError = "";
  let lastImage = null;

  while (Date.now() < deadline || attempt === 0) {
    attempt += 1;
    try {
      const image =
        mode === "viewport"
          ? await capturePageSequence(contents)
          : await captureFullPageSequence(contents);
      lastImage = image;
      lastAnalysis = analyzeImage(image, expected, guestMetrics);
      if (lastAnalysis.pass) {
        await saveImage(image, outputPath);
        const latencyMs = Date.now() - start;
        const result = {
          group: "permanent-parking",
          stateId: state.id,
          stateCode: state.code,
          stateLabel: state.label,
          variantId: variant.id,
          variantCode: variant.code,
          variantLabel: variant.label,
          attachTimeBackgroundThrottlingDisabled: variant.disableGuestBackgroundThrottlingAtAttach,
          phase,
          mode,
          repeatIndex,
          repeatTotal,
          targetIndex,
          attempts: attempt,
          latencyMs,
          outputPath,
          error: null,
          analysis: summarizeAnalysis(lastAnalysis),
          pass: true,
        };
        pass(
          `permanent ${state.code} ${variant.code} ${phase} ${mode} webview ${targetIndex + 1} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${analysisSize(lastAnalysis)} logical=${analysisLogicalSize(lastAnalysis)} bright=${lastAnalysis.brightRatio.toFixed(4)} text=${lastAnalysis.textNonUniform} file=${outputPath}`,
        );
        return result;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (!retryUntilPass) {
      break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(CAPTURE_RETRY_INTERVAL_MS, remainingMs));
  }

  if (lastImage && !lastImage.isEmpty()) {
    await saveImage(lastImage, outputPath);
  }
  const latencyMs = Date.now() - start;
  const bright = lastAnalysis ? lastAnalysis.brightRatio.toFixed(4) : "0.0000";
  const textNonUniform = lastAnalysis ? lastAnalysis.textNonUniform : false;
  const size = analysisSize(lastAnalysis);
  const logicalSize = analysisLogicalSize(lastAnalysis);
  const result = {
    group: "permanent-parking",
    stateId: state.id,
    stateCode: state.code,
    stateLabel: state.label,
    variantId: variant.id,
    variantCode: variant.code,
    variantLabel: variant.label,
    attachTimeBackgroundThrottlingDisabled: variant.disableGuestBackgroundThrottlingAtAttach,
    phase,
    mode,
    repeatIndex,
    repeatTotal,
    targetIndex,
    attempts: attempt,
    latencyMs,
    outputPath: lastImage && !lastImage.isEmpty() ? outputPath : null,
    error: lastError || null,
    analysis: summarizeAnalysis(lastAnalysis),
    pass: false,
  };
  console.log(
    `FAIL permanent ${state.code} ${variant.code} ${phase} ${mode} webview ${targetIndex + 1} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${size} logical=${logicalSize} bright=${bright} text=${textNonUniform} error=${lastError || "pixel verdict failed"} file=${result.outputPath || "none"}`,
  );
  return result;
}

async function writePermanentParkingResults(results) {
  await fsp.writeFile(
    path.join(OUT_DIR, "permanent-parking-results.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        soakMs: SOAK_MS,
        states: PERMANENT_PARKING_STATES,
        variants: PERMANENT_THROTTLING_VARIANTS,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

async function captureWithPrep({
  win,
  contents,
  mode,
  repeatIndex,
  targetIndex,
  guestMetrics,
  repeatTotal = REPEAT_COUNT,
  label = "prep",
  retryUntilPass = false,
}) {
  const preparation = await renderer(
    win,
    `window.captureHarness.prepareForPixelCapture(${JSON.stringify(targetIndex)})`,
  );
  const outputPath = path.join(
    OUT_DIR,
    `${mode}-webview-${targetIndex + 1}-${label}-${repeatIndex}.png`,
  );
  try {
    const expected =
      mode === "viewport"
        ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
        : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    let attempt = 0;
    let lastFailure = "capture did not run";
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const image =
          mode === "viewport"
            ? await capturePageSequence(contents)
            : await captureFullPageSequence(contents);
        const analysis = analyzeImage(image, expected, guestMetrics);
        const size = `${analysis.width}x${analysis.height}`;
        const logicalSize = `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
        const bright = analysis.brightRatio.toFixed(4);
        if (analysis.pass) {
          await saveImage(image, outputPath);
          pass(
            `${mode} webview ${targetIndex + 1} ${label} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
          );
          return analysis;
        }
        lastFailure = `size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (!retryUntilPass) {
        break;
      }
      await delay(Math.min(CAPTURE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    fail(
      `${mode} webview ${targetIndex + 1} ${label} ${repeatIndex}/${repeatTotal} failed attempts=${attempt} last=${lastFailure} file=${outputPath}`,
    );
  } finally {
    const restoredState = await renderer(
      win,
      `window.captureHarness.restorePixelCapture(${JSON.stringify(preparation.token)})`,
    );
    const style = restoredState.hostStyle;
    if (style.left !== "-20000px" || style.opacity !== "0") {
      fail(`restore left=${style.left} opacity=${style.opacity}`);
    }
  }
}

async function expectLegacySecondWebviewFailure({ win, contents, mode, guestMetrics }) {
  const targetIndex = 1;
  const preparation = await renderer(
    win,
    `window.captureHarness.prepareLegacyVerticalPixelCapture(${JSON.stringify(targetIndex)})`,
  );
  const outputPath = path.join(OUT_DIR, `${mode}-legacy-webview-${targetIndex + 1}.png`);
  try {
    const image =
      mode === "viewport"
        ? await capturePageSequence(contents)
        : await captureFullPageSequence(contents);
    await saveImage(image, outputPath);
    const expected =
      mode === "viewport"
        ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
        : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
    const analysis = analyzeImage(image, expected, guestMetrics);
    const size = `${analysis.width}x${analysis.height}`;
    const logicalSize = `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
    const bright = analysis.brightRatio.toFixed(4);
    if (analysis.pass) {
      fail(
        `${mode} legacy webview ${targetIndex + 1} unexpectedly captured size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
      );
    }
    pass(
      `${mode} legacy webview ${targetIndex + 1} reproduces no-frame size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pass(`${mode} legacy webview ${targetIndex + 1} reproduces no-frame error=${message}`);
  } finally {
    await renderer(
      win,
      `window.captureHarness.restoreLegacyVerticalParking(${JSON.stringify(preparation.token)})`,
    );
  }
}

async function captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode }) {
  const freshGuestPromise = waitForNextAttachedGuest();
  const targetIndex = await renderer(
    win,
    `window.captureHarness.addWebview(${JSON.stringify(fileUrl(path.join(ROOT, "delayed-bright.html")))})`,
  );
  const guest = await withTimeout(freshGuestPromise, "fresh did-attach-webview");
  const guestMetrics = await readGuestMetrics(guest);
  if (guestMetrics.innerWidth !== VIEWPORT_WIDTH || guestMetrics.innerHeight !== VIEWPORT_HEIGHT) {
    fail(
      `fresh guest viewport sizing webview ${targetIndex + 1} inner=${guestMetrics.innerWidth}x${guestMetrics.innerHeight} expected=${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
    );
  }
  pass(
    `fresh guest viewport sizing webview ${targetIndex + 1} inner=${guestMetrics.innerWidth}x${guestMetrics.innerHeight} dpr=${guestMetrics.devicePixelRatio}`,
  );
  await captureWithPrep({
    win,
    contents: guest,
    mode,
    repeatIndex: 1,
    targetIndex,
    guestMetrics,
    repeatTotal: 1,
    label: "fresh-delayed-first-frame",
    retryUntilPass: true,
  });
}

async function runPermanentFreshPhase(state, variant, results) {
  for (let repeatIndex = 1; repeatIndex <= FRESH_REPEAT_COUNT; repeatIndex += 1) {
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const { win, tracker } = await createPermanentHarnessWindow(state, variant);
      try {
        const sourceUrl = targetUrlForVariant(state, variant, "fresh", mode, 0);
        const { guest, targetIndex } = await appendPermanentWebview({
          win,
          tracker,
          state,
          sourceUrl,
        });
        const guestMetrics = await readGuestMetrics(guest);
        results.push(
          await measurePermanentCapture({
            contents: guest,
            mode,
            state,
            variant,
            phase: "fresh",
            repeatIndex,
            repeatTotal: FRESH_REPEAT_COUNT,
            targetIndex,
            guestMetrics,
            retryUntilPass: true,
          }),
        );
      } finally {
        await closeHarnessWindow(win);
      }
    }
  }
}

async function runPermanentSettledAndSoakPhases(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  try {
    const targets = [];
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const sourceUrl = targetUrlForVariant(state, variant, "settled", mode, targets.length);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push({ mode, ...target });
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    for (const target of targets) {
      for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode: target.mode,
            state,
            variant,
            phase: "settled",
            repeatIndex,
            repeatTotal: REPEAT_COUNT,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }

    console.log(`SOAK permanent ${state.code} idle ${SOAK_MS}ms`);
    await delay(SOAK_MS);

    for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
      for (const target of targets) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode: target.mode,
            state,
            variant,
            phase: "soak",
            repeatIndex,
            repeatTotal: REPEAT_COUNT,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }
  } finally {
    await closeHarnessWindow(win);
  }
}

async function runPermanentMultiTabPhase(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  try {
    const targets = [];
    for (let index = 0; index < 3; index += 1) {
      const sourceUrl = targetUrlForVariant(state, variant, "multi", "multi", index);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push(target);
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    for (const target of targets.slice(1, 3)) {
      for (const mode of PERMANENT_CAPTURE_MODES) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode,
            state,
            variant,
            phase: "multi-tab",
            repeatIndex: 1,
            repeatTotal: 1,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }
  } finally {
    await closeHarnessWindow(win);
  }
}

async function createOccludingWindow(targetWindow) {
  const bounds = targetWindow.getBounds();
  const handle = createInactiveHarnessWindow({
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop: true,
    backgroundColor: "#101010",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win: blocker } = handle;
  await blocker.loadURL(
    "data:text/html;charset=utf-8,<html><body style='margin:0;background:#101010'></body></html>",
  );
  await waitForInactiveReveal(handle, "occluding window");
  blocker.setAlwaysOnTop(true);
  await delay(500);
  return blocker;
}

async function runPermanentWindowHostilityPhase(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  let blocker = null;
  try {
    const targets = [];
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const sourceUrl = targetUrlForVariant(state, variant, "hostile", mode, targets.length);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push({ mode, ...target });
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    blocker = await createOccludingWindow(win);
    for (const target of targets) {
      results.push(
        await measurePermanentCapture({
          contents: target.guest,
          mode: target.mode,
          state,
          variant,
          phase: "window-occluded",
          repeatIndex: 1,
          repeatTotal: 1,
          targetIndex: target.targetIndex,
          guestMetrics: guestMetrics.get(target.targetIndex),
        }),
      );
    }
    await closeHarnessWindow(blocker);
    blocker = null;

    win.minimize();
    await delay(800);
    for (const target of targets) {
      results.push(
        await measurePermanentCapture({
          contents: target.guest,
          mode: target.mode,
          state,
          variant,
          phase: "window-minimized",
          repeatIndex: 1,
          repeatTotal: 1,
          targetIndex: target.targetIndex,
          guestMetrics: guestMetrics.get(target.targetIndex),
        }),
      );
    }
  } finally {
    if (blocker) {
      await closeHarnessWindow(blocker);
    }
    await closeHarnessWindow(win);
  }
}

async function runPermanentParkingState(state, variant, results) {
  console.log(`STATE permanent ${state.code} ${variant.code} ${state.label}`);
  await runPermanentFreshPhase(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentSettledAndSoakPhases(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentMultiTabPhase(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentWindowHostilityPhase(state, variant, results);
  await writePermanentParkingResults(results);
}

async function runPermanentParkingGroup() {
  const results = [];
  await fsp.rm(path.join(OUT_DIR, "permanent-parking"), { recursive: true, force: true });
  await fsp.rm(path.join(OUT_DIR, "permanent-parking-results.json"), { force: true });
  const keeper = await createPermanentKeeperWindow();
  const states =
    PERMANENT_STATE_FILTER.size === 0
      ? PERMANENT_PARKING_STATES
      : PERMANENT_PARKING_STATES.filter(
          (state) => PERMANENT_STATE_FILTER.has(state.id) || PERMANENT_STATE_FILTER.has(state.code),
        );
  console.log(`RUN permanent-parking states=${states.length} soakMs=${SOAK_MS}`);
  try {
    for (const state of states) {
      for (const variant of variantsForPermanentState(state)) {
        try {
          await runPermanentParkingState(state, variant, results);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`FAIL permanent ${state.code} ${variant.code} fatal error=${message}`);
          results.push({
            group: "permanent-parking",
            stateId: state.id,
            stateCode: state.code,
            stateLabel: state.label,
            variantId: variant.id,
            variantCode: variant.code,
            variantLabel: variant.label,
            attachTimeBackgroundThrottlingDisabled:
              variant.disableGuestBackgroundThrottlingAtAttach,
            phase: "fatal",
            mode: "setup",
            repeatIndex: 1,
            repeatTotal: 1,
            targetIndex: 0,
            attempts: 0,
            latencyMs: 0,
            outputPath: null,
            error: message,
            analysis: summarizeAnalysis(null),
            pass: false,
          });
          await writePermanentParkingResults(results);
        }
      }
    }
  } finally {
    await closeHarnessWindow(keeper);
  }
  const failedResults = results.filter((result) => !result.pass);
  if (failedResults.length > 0) {
    fail(`permanent parking failed ${failedResults.length}/${results.length} checks`);
  }
  return results;
}

function automationFixtureUrl() {
  const html = `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Automation Fixture</title></head>
      <style>
        body { min-height: 1800px; }
        #hover-target { display: none; }
        #hover-source:hover + #hover-target { display: inline-block; }
        #moving {
          animation: slide 320ms linear;
        }
        #drag-target {
          display: inline-block;
          margin-left: 24px;
          padding: 12px;
          border: 1px solid #888;
        }
        @keyframes slide {
          from { transform: translateX(80px); }
          to { transform: translateX(0); }
        }
      </style>
      <body>
        <main>
          <h1>Settings</h1>
          <section aria-label="Account">
            <p>Connected as Maya</p>
            <label for="name">Name</label>
            <input id="name" value="Maya">
            <a href="#docs">Read docs</a>
            <button id="save">Save changes</button>
            <button id="delayed" disabled>Delayed save</button>
            <button id="moving">Moving target</button>
            <button id="hover-source">Reveal actions</button>
            <button id="hover-target">Revealed action</button>
            <button id="drag-source">Drag source</button>
            <span id="drag-target">Drop target</span>
            <button id="dialog-alert">Open alert</button>
            <button id="dialog-confirm">Open confirm</button>
            <button id="dialog-prompt">Open prompt</button>
            <button id="dialog-beforeunload">Arm beforeunload</button>
            <input id="upload" type="file" aria-label="Upload receipt">
          </section>
        </main>
        <script>
          window.fixtureLog = [];
          document.getElementById("save").addEventListener("click", (event) => {
            window.fixtureLog.push({
              event: "click-save",
              trusted: event.isTrusted,
              button: event.button,
              detail: event.detail,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
            });
          });
          document.getElementById("save").addEventListener("mousedown", (event) => {
            window.fixtureLog.push({
              event: "down-save",
              trusted: event.isTrusted,
              button: event.button,
              detail: event.detail,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
            });
          });
          document.getElementById("name").addEventListener("input", (event) => {
            window.fixtureLog.push({ event: "input-name", trusted: event.isTrusted });
          });
          document.getElementById("delayed").addEventListener("click", (event) => {
            window.fixtureLog.push({ event: "click-delayed", trusted: event.isTrusted });
          });
          document.getElementById("moving").addEventListener("click", (event) => {
            window.fixtureLog.push({ event: "click-moving", trusted: event.isTrusted });
          });
          document.getElementById("drag-source").addEventListener("pointerdown", (event) => {
            window.fixtureLog.push({ event: "drag-down", trusted: event.isTrusted });
          });
          document.getElementById("drag-target").addEventListener("pointerup", (event) => {
            window.fixtureLog.push({ event: "drag-up", trusted: event.isTrusted });
          });
          document.getElementById("dialog-alert").addEventListener("click", () => {
            alert("Alert opened");
            window.fixtureLog.push({ event: "alert-returned" });
          });
          document.getElementById("dialog-confirm").addEventListener("click", () => {
            window.fixtureLog.push({ event: "confirm-result", value: confirm("Confirm action?") });
          });
          document.getElementById("dialog-prompt").addEventListener("click", () => {
            window.fixtureLog.push({ event: "prompt-result", value: prompt("Prompt value?", "Maya") });
          });
          window.beforeUnloadEnabled = false;
          document.getElementById("dialog-beforeunload").addEventListener("click", () => {
            window.beforeUnloadEnabled = true;
            window.fixtureLog.push({ event: "beforeunload-armed" });
          });
          window.addEventListener("beforeunload", (event) => {
            if (!window.beforeUnloadEnabled) return;
            event.preventDefault();
            event.returnValue = "Leave fixture?";
          });
          setTimeout(() => {
            document.getElementById("delayed").disabled = false;
          }, 250);
          window.pushFixtureState = () => history.pushState({}, "", "#advanced");
          window.sameUrlRerender = () => {
            const oldSave = document.getElementById("save");
            const nextSave = document.createElement("button");
            nextSave.id = "save";
            nextSave.textContent = "Save later";
            oldSave.replaceWith(nextSave);
          };
        </script>
      </body>
    </html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const AUTOMATION_SNAPSHOT_PROBE = String.raw`(() => {
  const refs = new Map();
  const lines = ['- document "Automation Fixture"'];
  let nextRef = 1;
  function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function fingerprint(element, role, name) {
    return { role, name, tagName: element.tagName.toLowerCase(), type: element.getAttribute('type') || '', ariaLabel: element.getAttribute('aria-label') || '' };
  }
  function runtime() {
    const api = {
      refs,
      resolve(ref, expected) {
        const element = refs.get(ref);
        if (!element || !element.isConnected) return { ok: false, reason: 'stale_ref' };
        const role = roleFor(element);
        const name = nameFor(element, role);
        const current = fingerprint(element, role, name);
        return current.role === expected.role && current.name === expected.name && current.tagName === expected.tagName && current.type === expected.type && current.ariaLabel === expected.ariaLabel
          ? { ok: true, element }
          : { ok: false, reason: 'stale_ref' };
      }
    };
    Object.defineProperty(window, '__PASEO_BROWSER_AUTOMATION__', { configurable: true, value: api });
    return api;
  }
  function roleFor(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') return element.type === 'file' ? 'button' : 'textbox';
    if (tag === 'button') return 'button';
    if (element.id === 'drag-target') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'section') return 'region';
    return '';
  }
  function nameFor(element, role) {
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    if (element.id) {
      const label = document.querySelector('label[for="' + element.id + '"]');
      if (label) return text(label.textContent);
    }
    return role === 'textbox' ? text(element.value || element.placeholder) : text(element.textContent);
  }
  const api = runtime();
  const heading = document.querySelector('h1');
  lines.push('  - heading "' + nameFor(heading, 'heading') + '" [level=1]');
  lines.push('  - text: "Connected as Maya"');
  for (const element of document.querySelectorAll('input, a, button, #drag-target')) {
    const role = roleFor(element);
    const name = nameFor(element, role);
    const ref = '@e' + nextRef++;
    const fp = fingerprint(element, role, name);
    api.refs.set(ref, element);
    lines.push('  - ' + role + ' "' + name + '" [ref=' + ref + ']');
  }
  return {
    snapshot: lines.join('\n'),
    refs: Array.from(api.refs.entries()).map(([ref, element]) => {
      const role = roleFor(element);
      return { ref, fingerprint: fingerprint(element, role, nameFor(element, role)) };
    })
  };
})()`;

async function attachAutomationDebugger(guest) {
  if (!guest.debugger.isAttached()) {
    guest.debugger.attach("1.3");
  }
  return (command, params = {}) => guest.debugger.sendCommand(command, params);
}

async function automationRefPoint(guest, ref, fingerprint) {
  const result = await guest.executeJavaScript(
    String.raw`(async () => {
      const fingerprint = ${JSON.stringify(fingerprint)};
      const ref = ${JSON.stringify(ref)};
      const deadline = performance.now() + 5000;
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sameRect = (a, b) =>
        Math.abs(a.x - b.x) < 0.25 &&
        Math.abs(a.y - b.y) < 0.25 &&
        Math.abs(a.width - b.width) < 0.25 &&
        Math.abs(a.height - b.height) < 0.25;
      const isDisabled = (element) =>
        Boolean(element.closest?.('[aria-disabled="true"]')) ||
        Boolean('disabled' in element && element.disabled);
      const isVisible = (element, rect) => {
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      while (performance.now() <= deadline) {
        const resolved = window.__PASEO_BROWSER_AUTOMATION__.resolve(ref, fingerprint);
        if (!resolved.ok || !resolved.element?.isConnected) return { ok: false, reason: 'stale_ref' };
        const element = resolved.element;
        const rect = element.getBoundingClientRect();
        if (!isVisible(element, rect) || isDisabled(element)) {
          await sleep(25);
          continue;
        }
        element.scrollIntoView?.({ block: 'center', inline: 'center' });
        await nextFrame();
        const first = element.getBoundingClientRect();
        await nextFrame();
        const second = element.getBoundingClientRect();
        if (!sameRect(first, second)) continue;
        const x = Math.min(Math.max(second.left + second.width / 2, 0), Math.max(window.innerWidth - 1, 0));
        const y = Math.min(Math.max(second.top + second.height / 2, 0), Math.max(window.innerHeight - 1, 0));
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { ok: true, x, y };
        await sleep(25);
      }
      return { ok: false, reason: 'timeout' };
    })()`,
    true,
  );
  if (!result || result.ok !== true) {
    fail(`automation ref ${ref} was not actionable: ${JSON.stringify(result)}`);
  }
  return { x: result.x, y: result.y };
}

async function automationClick(guest, refEntry, options = {}) {
  const send = await attachAutomationDebugger(guest);
  const point = await automationRefPoint(guest, refEntry.ref, refEntry.fingerprint);
  const button = options.button || "left";
  const modifiers = automationModifierMask(options.modifiers || []);
  const clickCount = options.doubleClick ? 2 : 1;
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons: automationButtonMask(button),
    clickCount,
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
  });
  return point;
}

async function automationHover(guest, refEntry) {
  const send = await attachAutomationDebugger(guest);
  const point = await automationRefPoint(guest, refEntry.ref, refEntry.fingerprint);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
}

async function automationScroll(guest, deltaX, deltaY) {
  const send = await attachAutomationDebugger(guest);
  const point = await guest.executeJavaScript(
    "({ x: Math.max(0, (window.innerWidth || 1) / 2), y: Math.max(0, (window.innerHeight || 1) / 2) })",
    true,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
}

async function automationDrag(guest, sourceRef, targetRef) {
  const send = await attachAutomationDebugger(guest);
  const source = await automationRefPoint(guest, sourceRef.ref, sourceRef.fingerprint);
  const target = await automationRefPoint(guest, targetRef.ref, targetRef.fingerprint);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: source.x,
    y: source.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function automationType(guest, refEntry, text) {
  const send = await attachAutomationDebugger(guest);
  await automationClick(guest, refEntry);
  await send("Input.insertText", { text });
}

async function automationEvaluate(guest, functionSource, refEntry) {
  return guest.executeJavaScript(
    String.raw`(async () => {
      const userFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
      const args = [];
      ${
        refEntry
          ? `const resolved = window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(refEntry.ref)}, ${JSON.stringify(refEntry.fingerprint)});
      if (!resolved.ok) return { ok: false, reason: "stale_ref" };
      args.push(resolved.element);`
          : ""
      }
      return JSON.stringify(await userFunction(...args));
    })()`,
    true,
  );
}

const AUTOMATION_DIALOG_POLICY = {
  alert: { action: "accepted", accept: true },
  confirm: { action: "dismissed", accept: false },
  prompt: { action: "dismissed", accept: false },
  beforeunload: { action: "dismissed", accept: false },
};

const AUTOMATION_PROMPT_SHIM_INSTALL = String.raw`(() => {
  const stateKey = "__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__";
  const state = window[stateKey] || { prompts: [], installed: false };
  window[stateKey] = state;
  if (state.installed) return true;
  window.prompt = (message = "", defaultValue = "") => {
    state.prompts.push({
      type: "prompt",
      message: String(message ?? ""),
      defaultValue: String(defaultValue ?? ""),
      action: "dismissed",
      timestamp: Date.now(),
    });
    return null;
  };
  state.installed = true;
  return true;
})()`;

const AUTOMATION_PROMPT_SHIM_DRAIN = String.raw`(() => {
  const state = window.__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__;
  if (!state || !Array.isArray(state.prompts)) return [];
  return state.prompts.splice(0);
})()`;

async function captureAutomationDialogs(guest, action, expectedCount) {
  const send = await attachAutomationDebugger(guest);
  await send("Page.enable");
  await send("Runtime.evaluate", {
    expression: AUTOMATION_PROMPT_SHIM_INSTALL,
    returnByValue: true,
  });
  const dialogs = [];
  const listener = (_event, method, params = {}) => {
    if (method !== "Page.javascriptDialogOpening") return;
    const type = AUTOMATION_DIALOG_POLICY[params.type] ? params.type : "alert";
    const policy = AUTOMATION_DIALOG_POLICY[type];
    dialogs.push({
      type,
      message: String(params.message || ""),
      ...(typeof params.defaultPrompt === "string" ? { defaultValue: params.defaultPrompt } : {}),
      action: policy.action,
      timestamp: Date.now(),
    });
    void send("Page.handleJavaScriptDialog", { accept: policy.accept });
  };
  guest.debugger.on("message", listener);
  try {
    await action();
    const promptResult = await send("Runtime.evaluate", {
      expression: AUTOMATION_PROMPT_SHIM_DRAIN,
      returnByValue: true,
    });
    if (Array.isArray(promptResult.result?.value)) {
      dialogs.push(...promptResult.result.value);
    }
    await waitForDialogCount(dialogs, expectedCount);
    return dialogs;
  } finally {
    guest.debugger.removeListener?.("message", listener);
  }
}

async function waitForDialogCount(dialogs, expectedCount) {
  const deadline = Date.now() + 1000;
  do {
    if (dialogs.length >= expectedCount) return;
    await delay(25);
  } while (Date.now() < deadline);
  fail(`automation observed ${dialogs.length}/${expectedCount} dialogs`);
}

function assertAutomationDialog(dialogs, expected) {
  const dialog = dialogs.find((entry) => entry.type === expected.type);
  if (!dialog) {
    fail(`automation did not report ${expected.type} dialog: ${JSON.stringify(dialogs)}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (dialog[key] !== value) {
      fail(`automation ${expected.type} dialog ${key}=${JSON.stringify(dialog[key])}`);
    }
  }
}

function automationButtonMask(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

function automationModifierMask(modifiers) {
  const masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  return modifiers.reduce((mask, modifier) => mask | masks[modifier], 0);
}

function automationRefByName(snapshot, name) {
  const entry = snapshot.refs.find((ref) => ref.fingerprint.name === name);
  if (!entry) {
    fail(`automation ref missing for ${name}`);
  }
  return entry;
}

async function automationLog(guest) {
  return guest.executeJavaScript("window.fixtureLog", true);
}

async function waitForAutomationLog(guest, predicate, label) {
  const deadline = Date.now() + 1000;
  do {
    const log = await automationLog(guest);
    if (Array.isArray(log) && log.some(predicate)) {
      return log;
    }
    await delay(25);
  } while (Date.now() < deadline);
  fail(`automation log never observed ${label}`);
}

async function runAutomationGroup() {
  const results = [];
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: {
          webviewCount: "0",
          permanentParkingState: "p1-overflow-1x1",
          targetUrl: automationFixtureUrl(),
        },
      }),
      "automation harness window loadFile",
    );
    await waitForInactiveReveal(handle, "automation harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: automationFixtureUrl(),
    });
    await waitForGuestLoad(guest);

    const first = await guest.executeJavaScript(AUTOMATION_SNAPSHOT_PROBE, true);
    assertAutomationSnapshot(first);
    pass("automation snapshot renders headings static text controls and refs");
    results.push({ group: "automation", check: "snapshot", pass: true });

    const saveRef = first.refs.find((ref) => ref.fingerprint.name === "Save changes");
    if (!saveRef) {
      fail("automation save ref missing");
    }
    await guest.executeJavaScript("window.pushFixtureState()", true);
    const pushStateResult = await guest.executeJavaScript(
      `window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(saveRef.ref)}, ${JSON.stringify(saveRef.fingerprint)}).ok`,
      true,
    );
    if (pushStateResult !== true) {
      fail("automation ref did not survive pushState");
    }
    pass("automation ref resolves after pushState");
    results.push({ group: "automation", check: "pushState-ref", pass: true });

    const pageEvaluate = await automationEvaluate(guest, "() => ({ title: document.title })");
    const refEvaluate = await automationEvaluate(
      guest,
      "(element) => ({ text: element.textContent.trim(), tag: element.tagName.toLowerCase() })",
      saveRef,
    );
    if (
      pageEvaluate !== '{"title":"Automation Fixture"}' ||
      refEvaluate !== '{"text":"Save changes","tag":"button"}'
    ) {
      fail(`automation evaluate returned page=${pageEvaluate} ref=${refEvaluate}`);
    }
    pass("automation evaluate runs in page context and receives ref element");
    results.push({ group: "automation", check: "evaluate", pass: true });

    await guest.executeJavaScript("window.scrollTo(0, 0)", true);
    await automationScroll(guest, 0, 500);
    await delay(100);
    const scrollY = await guest.executeJavaScript("window.scrollY", true);
    if (!(scrollY > 0)) {
      fail(`automation scroll did not change window.scrollY: ${scrollY}`);
    }
    pass("automation scroll changes the viewport scroll position");
    results.push({ group: "automation", check: "scroll", pass: true });

    const nameRef = automationRefByName(first, "Name");
    await automationType(guest, nameRef, " Ada");
    await automationClick(guest, saveRef);
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "input-name" && entry.trusted === true,
      "trusted input event",
    );
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "click-save" && entry.trusted === true,
      "trusted click event",
    );
    pass("automation trusted click and text input events reach the page");
    results.push({ group: "automation", check: "trusted-input", pass: true });

    const hoverRef = automationRefByName(first, "Reveal actions");
    await automationHover(guest, hoverRef);
    const hoverVisible = await guest.executeJavaScript(
      "getComputedStyle(document.getElementById('hover-target')).display !== 'none'",
      true,
    );
    if (hoverVisible !== true) {
      fail("automation hover did not reveal the hover target");
    }
    pass("automation hover reveals CSS :hover content");
    results.push({ group: "automation", check: "hover-reveal", pass: true });

    const delayedRef = automationRefByName(first, "Delayed save");
    await automationClick(guest, delayedRef);
    const delayedLog = await automationLog(guest);
    if (!delayedLog.some((entry) => entry.event === "click-delayed" && entry.trusted === true)) {
      fail("automation delayed enabled button did not receive trusted click");
    }
    pass("automation action waits for delayed enabled state");
    results.push({ group: "automation", check: "delayed-enable", pass: true });

    const movingRef = automationRefByName(first, "Moving target");
    await automationClick(guest, movingRef);
    const movingLog = await automationLog(guest);
    if (!movingLog.some((entry) => entry.event === "click-moving" && entry.trusted === true)) {
      fail("automation moving button did not receive trusted click");
    }
    pass("automation action waits for moving element stabilization");
    results.push({ group: "automation", check: "moving-stable", pass: true });

    const dragSourceRef = automationRefByName(first, "Drag source");
    const dragTargetRef = automationRefByName(first, "Drop target");
    await automationDrag(guest, dragSourceRef, dragTargetRef);
    const dragLog = await automationLog(guest);
    if (
      !dragLog.some((entry) => entry.event === "drag-down" && entry.trusted === true) ||
      !dragLog.some((entry) => entry.event === "drag-up" && entry.trusted === true)
    ) {
      fail("automation pointer drag did not produce trusted pointer events");
    }
    pass("automation pointer-event drag reaches source and target");
    results.push({ group: "automation", check: "pointer-drag", pass: true });

    await automationClick(guest, saveRef, {
      button: "right",
      doubleClick: true,
      modifiers: ["Control", "Shift"],
    });
    const optionsLog = await automationLog(guest);
    if (
      !optionsLog.some(
        (entry) =>
          entry.event === "down-save" &&
          entry.trusted === true &&
          entry.button === 2 &&
          entry.detail === 2 &&
          entry.ctrlKey === true &&
          entry.shiftKey === true,
      )
    ) {
      fail("automation click options did not affect button/modifiers/double-click count");
    }
    pass("automation click options affect button modifiers and double-click count");
    results.push({ group: "automation", check: "click-options", pass: true });

    const alertRef = automationRefByName(first, "Open alert");
    const alertDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, alertRef),
      1,
    );
    assertAutomationDialog(alertDialogs, {
      type: "alert",
      message: "Alert opened",
      action: "accepted",
    });
    await waitForAutomationLog(guest, (entry) => entry.event === "alert-returned", "alert return");
    pass("automation alert dialogs are accepted and reported");
    results.push({ group: "automation", check: "dialog-alert", pass: true });

    const confirmRef = automationRefByName(first, "Open confirm");
    const confirmDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, confirmRef),
      1,
    );
    assertAutomationDialog(confirmDialogs, {
      type: "confirm",
      message: "Confirm action?",
      action: "dismissed",
    });
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "confirm-result" && entry.value === false,
      "confirm dismissal",
    );
    pass("automation confirm dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-confirm", pass: true });

    const promptRef = automationRefByName(first, "Open prompt");
    const promptDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, promptRef),
      1,
    );
    assertAutomationDialog(promptDialogs, {
      type: "prompt",
      message: "Prompt value?",
      defaultValue: "Maya",
      action: "dismissed",
    });
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "prompt-result" && entry.value === null,
      "prompt dismissal",
    );
    pass("automation prompt dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-prompt", pass: true });

    const beforeUnloadRef = automationRefByName(first, "Arm beforeunload");
    await automationClick(guest, beforeUnloadRef);
    const beforeUrl = guest.getURL();
    const beforeUnloadDialogs = await captureAutomationDialogs(
      guest,
      async () => {
        await guest.loadURL(automationFixtureUrl()).catch(() => {});
      },
      1,
    );
    assertAutomationDialog(beforeUnloadDialogs, {
      type: "beforeunload",
      action: "dismissed",
    });
    if (guest.getURL() !== beforeUrl) {
      fail("automation beforeunload dismissal did not cancel navigation");
    }
    pass("automation beforeunload dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-beforeunload", pass: true });

    await guest.executeJavaScript("window.sameUrlRerender()", true);
    const rerenderResult = await guest.executeJavaScript(
      `window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(saveRef.ref)}, ${JSON.stringify(saveRef.fingerprint)}).reason`,
      true,
    );
    if (rerenderResult !== "stale_ref") {
      fail(`automation same-url rerender returned ${rerenderResult}`);
    }
    pass("automation same-url rerender stales old ref");
    results.push({ group: "automation", check: "same-url-stale-ref", pass: true });

    const second = await guest.executeJavaScript(AUTOMATION_SNAPSHOT_PROBE, true);
    const uploadRef = second.refs.find((ref) => ref.fingerprint.name === "Upload receipt");
    if (!uploadRef) {
      fail("automation upload ref missing");
    }
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach("1.3");
    }
    const evaluated = await guest.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(uploadRef.ref)}, ${JSON.stringify(uploadRef.fingerprint)}).element)()`,
      objectGroup: "paseo-browser-automation",
      returnByValue: false,
    });
    const described = await guest.debugger.sendCommand("DOM.describeNode", {
      objectId: evaluated.result.objectId,
    });
    if (!described.node || typeof described.node.backendNodeId !== "number") {
      fail("automation upload ref did not resolve to backendNodeId");
    }
    pass("automation upload ref resolves to backendNodeId");
    results.push({ group: "automation", check: "upload-backend-node", pass: true });

    // Resize is not harness-testable: the harness hosts webviews in the parked
    // 1px resident host, and Electron does not propagate CSS-box resizes to a
    // parked guest's capture surface (see docs/browser-capture-harness.md).
    // The production resize path is app-owned webview sizing, covered by
    // packages/app/src/browser-automation/handler.test.ts.

    await fsp.writeFile(
      path.join(OUT_DIR, "automation-results.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
    return results;
  } finally {
    await closeHarnessWindow(win);
  }
}

function assertAutomationSnapshot(snapshot) {
  const text = snapshot && snapshot.snapshot;
  if (typeof text !== "string") {
    fail("automation snapshot returned no text");
  }
  for (const expected of [
    'heading "Settings"',
    'text: "Connected as Maya"',
    'textbox "Name" [ref=@e1]',
    'link "Read docs"',
    'button "Save changes"',
    'button "Upload receipt"',
  ]) {
    if (!text.includes(expected)) {
      fail(`automation snapshot missing ${expected}`);
    }
  }
  if (text.includes("selector")) {
    fail("automation snapshot exposed selector text");
  }
}

async function createBrowserProfileHarnessWindow(partition, sourceUrl) {
  const handle = createInactiveHarnessWindow({
    width: 640,
    height: 480,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win);
  const guestsPromise = tracker.waitForAttachedGuests(2);
  await withTimeout(
    win.loadFile(path.join(ROOT, "index.html"), {
      query: {
        webviewCount: "2",
        targetUrl: sourceUrl,
        profilePartition: partition,
        profileBrowserIds: "browser-first,browser-second",
      },
    }),
    "browser profile window loadFile",
  );
  await waitForInactiveReveal(handle, "browser profile window");
  const [guests, identities] = await withTimeout(
    Promise.all([guestsPromise, renderer(win, "window.captureHarness.profileIdentities()")]),
    "browser profile did-attach",
    BROWSER_PROFILE_TIMEOUT_MS,
  );
  return { handle, guests, identities };
}

async function readBrowserProfileFixture(guest) {
  return await guest.executeJavaScript(`({
    cookie: document.cookie,
    localStorage: localStorage.getItem("paseo-browser-profile")
  })`);
}

function assertBrowserProfileFixture(state, expectedValue, label) {
  if (state.localStorage !== expectedValue) {
    fail(`${label} localStorage mismatch ${JSON.stringify(state)}`);
  }
  if (!state.cookie.split("; ").includes(`paseo-browser-profile=${expectedValue}`)) {
    fail(`${label} cookie mismatch ${JSON.stringify(state)}`);
  }
}

function resolveBrowserProfileGuests(profileWindow, profileSession) {
  if (profileWindow.identities.length !== 2 || profileWindow.guests.length !== 2) {
    fail("browser profile harness did not attach exactly two guests");
  }
  const guestsById = new Map(profileWindow.guests.map((guest) => [guest.id, guest]));
  const [firstIdentity, secondIdentity] = profileWindow.identities;
  const firstGuest = guestsById.get(firstIdentity.webContentsId);
  const secondGuest = guestsById.get(secondIdentity.webContentsId);
  if (!firstGuest || !secondGuest) {
    fail("browser profile renderer identities did not map to attached main-process guests");
  }
  if (
    firstIdentity.browserId !== "browser-first" ||
    firstIdentity.webContentsId !== firstGuest.id
  ) {
    fail(
      `browser profile first attach mismatch ${JSON.stringify(firstIdentity)} main=${firstGuest.id}`,
    );
  }
  if (
    secondIdentity.browserId !== "browser-second" ||
    secondIdentity.webContentsId !== secondGuest.id
  ) {
    fail(
      `browser profile second attach mismatch ${JSON.stringify(secondIdentity)} main=${secondGuest.id}`,
    );
  }
  if (
    firstGuest.hostWebContents !== profileWindow.handle.win.webContents ||
    secondGuest.hostWebContents !== profileWindow.handle.win.webContents
  ) {
    fail("browser profile guests were not owned by their renderer");
  }
  if (firstGuest.session !== profileSession || secondGuest.session !== profileSession) {
    fail("browser profile guests did not share the persistent session");
  }
  return [firstGuest, secondGuest];
}

async function prepareBrowserProfileValue(firstGuest, profileSession) {
  if (BROWSER_PROFILE_PHASE === "read") {
    return (await fsp.readFile(BROWSER_PROFILE_VALUE_FILE, "utf8")).trim();
  }

  const profileValue = `profile-${Date.now()}-${process.pid}`;
  await firstGuest.executeJavaScript(`(() => {
    const value = ${JSON.stringify(profileValue)};
    localStorage.setItem("paseo-browser-profile", value);
    document.cookie = "paseo-browser-profile=" + value + "; Max-Age=86400; SameSite=Lax";
  })()`);
  if (BROWSER_PROFILE_PHASE === "write") {
    await fsp.writeFile(BROWSER_PROFILE_VALUE_FILE, `${profileValue}\n`);
    await profileSession.cookies.flushStore();
  }
  return profileValue;
}

async function runBrowserProfileGroup() {
  if (!["write", "read"].includes(BROWSER_PROFILE_PHASE)) {
    fail(`unknown browser profile phase ${BROWSER_PROFILE_PHASE}`);
  }
  const partition = "persist:paseo-browser-profile-harness-restart";
  const profileSession = session.fromPartition(partition);
  const fixture = await startBrowserProfileServer();
  const windows = [];
  try {
    if (BROWSER_PROFILE_PHASE === "write") {
      await profileSession.clearStorageData();
      await profileSession.clearCache();
    }
    const profileWindow = await createBrowserProfileHarnessWindow(partition, fixture.origin);
    windows.push(profileWindow.handle);
    const [firstGuest, secondGuest] = resolveBrowserProfileGuests(profileWindow, profileSession);
    await Promise.all([waitForGuestLoad(firstGuest), waitForGuestLoad(secondGuest)]);

    const profileValue = await prepareBrowserProfileValue(firstGuest, profileSession);

    const firstState = await readBrowserProfileFixture(firstGuest);
    const secondState = await readBrowserProfileFixture(secondGuest);
    assertBrowserProfileFixture(firstState, profileValue, "browser profile first tab");
    assertBrowserProfileFixture(secondState, profileValue, "browser profile second tab");

    pass("browser profile renderer did-attach identities match their main-process guests");
    pass("browser profile tabs share cookies, localStorage, and one persistent session");
    if (BROWSER_PROFILE_PHASE === "read") {
      pass("browser profile cookies and localStorage survived an Electron process restart");
    }
    const results = [
      { group: "browser-profile", check: "renderer-main-identity", pass: true },
      { group: "browser-profile", check: "shared-profile-data", pass: true },
    ];
    if (BROWSER_PROFILE_PHASE === "read") {
      results.push({
        group: "browser-profile",
        check: "process-restart-persistence",
        pass: true,
      });
    }
    return results;
  } finally {
    for (const handle of windows) {
      await closeHarnessWindow(handle.win);
    }
    if (BROWSER_PROFILE_PHASE !== "write") {
      await profileSession.clearStorageData();
      await profileSession.clearCache();
    }
    await closeServer(fixture.server);
  }
}

async function main() {
  ensureDirSync(OUT_DIR);
  if (
    !["all", "existing", "permanent-parking", "automation", "browser-profile"].includes(
      HARNESS_GROUP,
    )
  ) {
    fail(`unknown harness group ${HARNESS_GROUP}`);
  }

  if (HARNESS_GROUP === "browser-profile") {
    const browserProfileResults = await runBrowserProfileGroup();
    await fsp.writeFile(
      path.join(OUT_DIR, "results.json"),
      `${JSON.stringify(
        { generatedAt: new Date().toISOString(), browserProfileResults },
        null,
        2,
      )}\n`,
    );
    pass(`capture harness browser-profile complete output=${OUT_DIR}`);
    return;
  }

  if (HARNESS_GROUP === "automation") {
    const automationResults = await runAutomationGroup();
    await fsp.writeFile(
      path.join(OUT_DIR, "results.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          automationResults,
        },
        null,
        2,
      )}\n`,
    );
    pass(`capture harness automation complete output=${OUT_DIR}`);
    return;
  }

  if (HARNESS_GROUP === "permanent-parking") {
    const permanentParkingResults = await runPermanentParkingGroup();
    await fsp.writeFile(
      path.join(OUT_DIR, "results.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          permanentParkingResults,
        },
        null,
        2,
      )}\n`,
    );
    pass(`capture harness permanent-parking complete output=${OUT_DIR}`);
    return;
  }

  const attachedGuests = [];
  const freshGuestWaiters = [];
  let resolveGuests;
  const guestsPromise = new Promise((resolve) => {
    resolveGuests = resolve;
  });
  const waitForNextAttachedGuest = () =>
    new Promise((resolve) => {
      freshGuestWaiters.push(resolve);
    });
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;

  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  win.webContents.on("did-attach-webview", (_event, contents) => {
    attachedGuests.push(contents);
    const waiter = freshGuestWaiters.shift();
    if (waiter) {
      waiter(contents);
    }
    if (attachedGuests.length >= 2) {
      resolveGuests(attachedGuests);
    }
  });

  await win.loadFile(path.join(ROOT, "index.html"), {
    query: { targetUrl: fileUrl(path.join(ROOT, "bright.html")), webviewCount: "2" },
  });
  await waitForInactiveReveal(handle, "capture harness window");
  await withTimeout(guestsPromise, "did-attach-webview");
  await Promise.all(attachedGuests.map((guest) => waitForGuestLoad(guest)));
  await renderer(win, "window.captureHarness.waitForFrames(2)");
  const webContentsIds = await renderer(win, "window.captureHarness.webContentsIds()");
  const guestsById = new Map(attachedGuests.map((guest) => [guest.id, guest]));
  const guests = webContentsIds.map((id) => guestsById.get(id));
  if (guests.some((guest) => !guest)) {
    fail(
      `could not map webviews to guest contents ids=${JSON.stringify(webContentsIds)} attached=${attachedGuests.map((guest) => guest.id).join(",")}`,
    );
  }
  const guestMetrics = await Promise.all(guests.map((guest) => readGuestMetrics(guest)));

  guestMetrics.forEach((metrics, index) => {
    if (metrics.innerWidth !== VIEWPORT_WIDTH || metrics.innerHeight !== VIEWPORT_HEIGHT) {
      fail(
        `guest viewport sizing webview ${index + 1} inner=${metrics.innerWidth}x${metrics.innerHeight} expected=${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
      );
    }
    pass(
      `guest viewport sizing webview ${index + 1} inner=${metrics.innerWidth}x${metrics.innerHeight} dpr=${metrics.devicePixelRatio}`,
    );
  });

  await renderer(win, "window.captureHarness.restoreParking()");
  try {
    const image = await capturePageSequence(guests[0]);
    const analysis = analyzeImage(
      image,
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 },
      guestMetrics[0],
    );
    fail(
      `parked webview unexpectedly captured size=${analysis.width}x${analysis.height} bright=${analysis.brightRatio.toFixed(4)}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pass(`parked webview has no copyable viewport frame error=${message}`);
  }

  await expectLegacySecondWebviewFailure({
    win,
    contents: guests[1],
    mode: "viewport",
    guestMetrics: guestMetrics[1],
  });
  await expectLegacySecondWebviewFailure({
    win,
    contents: guests[1],
    mode: "full-page",
    guestMetrics: guestMetrics[1],
  });

  await renderer(win, "window.captureHarness.restoreParking()");

  await captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode: "viewport" });
  await renderer(win, "window.captureHarness.restoreParking()");
  await captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode: "full-page" });
  await renderer(win, "window.captureHarness.restoreParking()");

  const results = [];
  for (const targetIndex of [0, 1]) {
    for (let index = 1; index <= REPEAT_COUNT; index += 1) {
      results.push(
        await captureWithPrep({
          win,
          contents: guests[targetIndex],
          mode: "viewport",
          repeatIndex: index,
          targetIndex,
          guestMetrics: guestMetrics[targetIndex],
        }),
      );
    }
    for (let index = 1; index <= REPEAT_COUNT; index += 1) {
      results.push(
        await captureWithPrep({
          win,
          contents: guests[targetIndex],
          mode: "full-page",
          repeatIndex: index,
          targetIndex,
          guestMetrics: guestMetrics[targetIndex],
        }),
      );
    }
  }

  const permanentParkingResults = HARNESS_GROUP === "all" ? await runPermanentParkingGroup() : [];

  await fsp.writeFile(
    path.join(OUT_DIR, "results.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        guestMetrics,
        results,
        permanentParkingResults,
      },
      null,
      2,
    )}\n`,
  );
  pass(`capture harness complete output=${OUT_DIR}`);

  if (!win.isDestroyed()) {
    win.close();
  }
}

app
  .on("window-all-closed", () => {
    // The permanent parking sweep intentionally opens and closes many phase windows.
  })
  .whenReady()
  .then(() => {
    applyMacHarnessActivationPolicyBeforeWindows();
    return main();
  })
  .then(() => app.quit())
  .catch(async (error) => {
    console.error(error);
    try {
      await fsp.writeFile(
        path.join(OUT_DIR, "fatal-error.txt"),
        `${error && error.stack ? error.stack : String(error)}\n`,
      );
    } catch {
      // Ignore reporting failures during shutdown.
    }
    app.exit(1);
  });
