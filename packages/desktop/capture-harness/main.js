const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = __dirname;
const OUT_DIR = process.env.PASEO_CAPTURE_HARNESS_OUT_DIR || path.join(ROOT, "out");
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const FULL_PAGE_HEIGHT = 1600;
const CAPTURE_TIMEOUT_MS = 5000;
const REPEAT_COUNT = 5;

function fileUrl(filePath) {
  return new URL(`file://${filePath}`).toString();
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
      brightRatio: 0,
      textNonUniform: false,
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

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.log(`FAIL ${message}`);
  throw new Error(message);
}

async function saveImage(image, outputPath) {
  await fsp.writeFile(outputPath, image.toPNG());
}

async function waitForGuestLoad(contents) {
  await new Promise((resolve) => {
    if (!contents.isLoading()) {
      resolve();
      return;
    }
    contents.once("did-finish-load", resolve);
    contents.once("did-fail-load", resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
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
  const previousBackgroundThrottling = contents.getBackgroundThrottling();
  contents.setBackgroundThrottling(false);
  try {
    contents.invalidate();
    return await withTimeout(contents.capturePage(undefined, { stayHidden: false }), "capturePage");
  } finally {
    contents.setBackgroundThrottling(previousBackgroundThrottling);
  }
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

async function captureWithPrep({ win, contents, mode, repeatIndex, targetIndex, guestMetrics }) {
  const preparation = await renderer(
    win,
    `window.captureHarness.prepareForPixelCapture(${JSON.stringify(targetIndex)})`,
  );
  const outputPath = path.join(
    OUT_DIR,
    `${mode}-webview-${targetIndex + 1}-prep-${repeatIndex}.png`,
  );
  try {
    const image =
      mode === "viewport" ? await capturePageSequence(contents) : await captureFullPage(contents);
    await saveImage(image, outputPath);
    const expected =
      mode === "viewport"
        ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
        : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
    const analysis = analyzeImage(image, expected, guestMetrics);
    const size = `${analysis.width}x${analysis.height}`;
    const logicalSize = `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
    const bright = analysis.brightRatio.toFixed(4);
    if (!analysis.pass) {
      fail(
        `${mode} webview ${targetIndex + 1} prep ${repeatIndex}/${REPEAT_COUNT} size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
      );
    }
    pass(
      `${mode} webview ${targetIndex + 1} prep ${repeatIndex}/${REPEAT_COUNT} size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
    );
    return analysis;
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
      mode === "viewport" ? await capturePageSequence(contents) : await captureFullPage(contents);
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

async function main() {
  ensureDirSync(OUT_DIR);

  const attachedGuests = [];
  let resolveGuests;
  const guestsPromise = new Promise((resolve) => {
    resolveGuests = resolve;
  });
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  win.webContents.on("did-attach-webview", (_event, contents) => {
    attachedGuests.push(contents);
    if (attachedGuests.length >= 2) {
      resolveGuests(attachedGuests);
    }
  });

  await win.loadFile(path.join(ROOT, "index.html"), {
    query: { targetUrl: fileUrl(path.join(ROOT, "bright.html")), webviewCount: "2" },
  });
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

  await fsp.writeFile(
    path.join(OUT_DIR, "results.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), guestMetrics, results }, null, 2)}\n`,
  );
  pass(`capture harness complete output=${OUT_DIR}`);

  if (!win.isDestroyed()) {
    win.close();
  }
}

app
  .whenReady()
  .then(main)
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
