import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../../..");
const generated = await fs.readFile(path.join(directory, "runtime/html.gen.ts"), "utf8");
const html = JSON.parse(generated.match(/export const pdfRuntimeHtml = ([\s\S]*);\s*$/)[1]);
const fixture = await fs.readFile(path.join(directory, "fixtures/sample.pdf"));
const browser = await chromium.launch({
  executablePath:
    process.env.PASEO_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error("Reader error:", error.message));
  const requests = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.setContent(
    '<iframe id="reader" sandbox="allow-scripts allow-forms" style="width:100%;height:95vh;border:0"></iframe>',
  );
  await page.locator("#reader").evaluate((frame, source) => {
    // Android WebView 124 lacks these APIs although newer desktop Chrome has them.
    frame.srcdoc = source.replace("<script>", "<script>URL.parse=undefined;Promise.try=undefined;");
  }, html);
  const viewer = page.frameLocator("#reader");
  console.log("Waiting for viewer frame");
  await viewer.locator("canvas").waitFor();
  console.log("Viewer canvas ready");
  const readerFrame = await (await page.locator("#reader").elementHandle()).contentFrame();
  console.log("Waiting for reader API");
  await readerFrame.waitForFunction(() => Boolean(window.PaseoPdf), undefined, { timeout: 15000 });
  assert.equal(await readerFrame.evaluate(() => typeof URL.parse), "function");
  assert.equal(await readerFrame.evaluate(() => typeof Promise.try), "function");
  console.log("Sending PDF bytes");
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    document.querySelector("iframe").contentWindow.postMessage(
      {
        type: "paseo-pdf-open",
        input: {
          data: bytes,
          background: "#141414",
          foreground: "#eeeeee",
          border: "#444444",
          search: "搜索文字",
          password: "PDF 密码",
          loading: "正在加载",
        },
      },
      "*",
    );
  }, fixture.toString("base64"));
  console.log("Waiting for PDF render");
  await viewer
    .locator("#status")
    .filter({ hasText: "/ 2" })
    .waitFor({ timeout: 30_000 })
    .catch(async (error) => {
      console.error("Viewer status:", await viewer.locator("#status").textContent());
      console.error("Viewer error:", await viewer.locator("#error").textContent());
      throw error;
    });
  assert.equal(await viewer.locator("#error").textContent(), "");
  assert.equal(await viewer.locator("#page").inputValue(), "1");
  const darkPixels = await viewer.locator("canvas").evaluate((canvas) => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 3] > 0) count++;
    return count;
  });
  assert.ok(darkPixels > 100, "PDF text should render onto the canvas");
  await viewer.locator("#next").click();
  await readerFrame.waitForFunction(
    () => document.querySelector("#page").value === "2",
    undefined,
    { timeout: 15000 },
  );
  await viewer.locator("#zoom-in").click();
  await viewer.locator("#status").filter({ hasText: "125%" }).waitFor();
  await viewer.locator("#search").fill("page one");
  await viewer.locator("#search").press("Enter");
  await readerFrame.waitForFunction(
    () => document.querySelector("#page").value === "1",
    undefined,
    { timeout: 15000 },
  );
  await page.screenshot({ path: path.join(root, ".dev/pdf-preview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await readerFrame.waitForFunction(() => document.querySelector("canvas").width < 500, undefined, {
    timeout: 15000,
  });
  assert.ok(
    await viewer.locator("header").evaluate((header) => header.scrollWidth <= window.innerWidth),
    "Toolbar should wrap on a phone",
  );
  await page.screenshot({ path: path.join(root, ".dev/pdf-preview-mobile.png") });
  const chinese = await fs.readFile(path.join(directory, "fixtures/chinese.pdf"));
  await readerFrame.evaluate(
    (base64) =>
      window.PaseoPdf.open({
        data: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
        background: "#141414",
        foreground: "#eeeeee",
        border: "#444444",
        search: "搜索",
        password: "密码",
        loading: "正在加载",
      }),
    chinese.toString("base64"),
  );
  await viewer.locator("#status").filter({ hasText: "/ 1" }).waitFor();
  assert.equal(await viewer.locator("#error").textContent(), "");
  await page.screenshot({ path: path.join(root, ".dev/pdf-preview-chinese.png") });
  assert.deepEqual(
    requests,
    [],
    "The reader must not request online fonts, viewers, or document services",
  );
  console.log(
    "PASS: offline PDF renders text, changes pages, zooms and searches without HTTP requests; phone toolbar and Chinese PDF render; missing WebView APIs are supplied by the legacy bundle",
  );
} finally {
  await browser.close();
}
