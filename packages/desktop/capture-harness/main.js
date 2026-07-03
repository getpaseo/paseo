const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, nativeImage, screen } = require("electron");

const ROOT = __dirname;
const OUT_DIR = process.env.PASEO_CAPTURE_HARNESS_OUT_DIR || path.join(ROOT, "out");
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const FULL_PAGE_HEIGHT = 1600;
const CAPTURE_TIMEOUT_MS = 5000;
const CAPTURE_RETRY_INTERVAL_MS = 200;
const REPEAT_COUNT = 5;
const FRESH_REPEAT_COUNT = 3;
const SOAK_MS = Number(process.env.PASEO_CAPTURE_HARNESS_SOAK_MS || 75000);
const HARNESS_GROUP = process.env.PASEO_CAPTURE_HARNESS_GROUP || "permanent-parking";
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

function withTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${CAPTURE_TIMEOUT_MS}ms`));
    }, CAPTURE_TIMEOUT_MS);
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
  win.webContents.on("did-attach-webview", (_event, contents) => {
    if (input.disableGuestBackgroundThrottlingAtAttach) {
      contents.setBackgroundThrottling(false);
    }
    attachedGuests.push(contents);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(contents);
    }
  });
  return {
    attachedGuests,
    waitForNextAttachedGuest() {
      return new Promise((resolve) => {
        waiters.push(resolve);
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

async function main() {
  ensureDirSync(OUT_DIR);
  if (!["all", "existing", "permanent-parking"].includes(HARNESS_GROUP)) {
    fail(`unknown harness group ${HARNESS_GROUP}`);
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
