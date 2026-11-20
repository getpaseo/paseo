// Native mouse input is required: CDP mouse events do not move Electron windows.
// Load production CSS so restoring the global no-drag rule reproduces the failure.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { BrowserWindow } = require("electron");

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const INDEX_HTML = path.join(PACKAGE_ROOT, "app", "public", "index.html");
const MOUSE_SOURCE = path.join(__dirname, "titlebar-drag-mouse.m");
const BASE = { x: 100, y: 150 };
const DRAG_DELTA = { x: 80, y: 50 };
const DRAG_POINTS = [
  { check: "header-overlay-blank", x: 625, y: 18 },
  { check: "tab-row-overlay-blank", x: 625, y: 50 },
  { check: "sidebar-overlay-blank", x: 125, y: 18 },
  { check: "direct-rail-blank", x: 125, y: 50 },
];
const CLICK_POINTS = [
  { check: "header-button-click", id: "header-btn", x: 955, y: 18 },
  { check: "window-owned-toggle-click", id: "window-toggle", x: 40, y: 18 },
  { check: "window-owned-focusable-click", id: "focusable", x: 320, y: 18 },
  { check: "window-owned-negative-tabindex-button-click", id: "negative-button", x: 400, y: 18 },
  { check: "sidebar-tab-click", id: "sidebar-btn", x: 205, y: 18 },
  { check: "rail-tab-click", id: "rail-btn", x: 205, y: 50 },
  { check: "portal-button-click", id: "portal-btn", x: 490, y: 18 },
  { check: "floating-panel-button-click", id: "floating-btn", x: 785, y: 18 },
];

/** Static overlays and a sibling window control mirror the app shell ownership. */
function buildFixtureHtml(appStyles) {
  const dragOverlay =
    'style="position:absolute;top:0;left:0;display:block;width:100%;height:100%;-webkit-app-region:drag"';
  const button = (id, style) =>
    `<button id="${id}" style="${style}" onclick="count('${id}')">${id}</button>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${appStyles}</style>
<style>html,body{margin:0;width:100%;height:100%;background:#161616;color:#ddd;font:12px -apple-system,sans-serif;user-select:none}
.pane{position:absolute}</style></head><body>
<div class="pane" id="sidebar" style="left:0;top:0;width:250px;height:600px;background:#1d1d1d">
  <div class="pane" style="left:0;top:0;width:250px;height:36px">
    <div ${dragOverlay}></div>
    ${button("sidebar-btn", "position:absolute;right:8px;top:6px;width:60px;height:24px")}
  </div>
  <div class="pane"
       style="left:0;top:36px;width:250px;height:28px;-webkit-app-region:drag">
    ${button("rail-btn", "position:absolute;right:8px;top:2px;width:60px;height:24px")}
  </div>
</div>
<div class="pane" id="header" style="left:250px;top:0;width:750px;height:36px">
  <div ${dragOverlay}></div>
  ${button("header-btn", "position:absolute;right:8px;top:6px;width:60px;height:24px")}
</div>
<div class="pane" style="left:250px;top:36px;width:750px;height:28px">
  <div ${dragOverlay}></div>
</div>
<!-- The sidebar toggle belongs to the window, outside every drag surface subtree. -->
${button("window-toggle", "position:absolute;left:10px;top:6px;width:60px;height:24px;z-index:2")}
<div id="focusable" tabindex="0" onclick="count('focusable')"
     style="position:absolute;left:290px;top:6px;width:60px;height:24px;z-index:2">Focusable</div>
<div id="negative-button" role="button" tabindex="-1" onclick="count('negative-button')"
     style="position:absolute;left:370px;top:6px;width:60px;height:24px;z-index:2">Button</div>
<div class="pane" id="chat-root" style="left:250px;top:64px;width:750px;height:536px;overflow:clip">
  <div id="scroller" tabindex="-1" data-window-content
       style="width:100%;height:100%;overflow-y:auto;overflow-x:clip;outline:none">
    <div id="chat-inner" style="height:2000px;position:relative">
      <a id="chat-link" href="#" onclick="event.preventDefault();count('chat-link')" style="position:absolute;left:250px;top:160px;width:180px;height:24px">Chat link</a>
      ${button("chat-code", "position:absolute;left:250px;top:320px;width:180px;height:24px")}
      <div id="chat-file" role="link" tabindex="0" onclick="count('chat-file')" style="position:absolute;left:250px;top:480px;width:180px;height:24px">file.ts</div>
    </div>
  </div>
</div>
<div id="overlay-root" style="position:fixed;inset:0;pointer-events:none;z-index:9999">
  ${button("portal-btn", "position:fixed;left:460px;top:6px;width:60px;height:24px;pointer-events:auto")}
</div>
<div style="position:fixed;inset:0;pointer-events:none;z-index:9999">
  ${button("floating-btn", "position:fixed;left:755px;top:6px;width:60px;height:24px;pointer-events:auto")}
</div>
<script>
  window.__clicks = {};
  window.count = (id) => { window.__clicks[id] = (window.__clicks[id] || 0) + 1; };
  window.__fixture = {
    setScroll(value) { document.getElementById("scroller").scrollTop = value; return this.snapshot(); },
    placeControl(id, y) {
      const control = document.getElementById(id);
      const rect = control.getBoundingClientRect();
      document.getElementById("scroller").scrollTop += rect.top + rect.height / 2 - y;
      const placed = control.getBoundingClientRect();
      return { x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 };
    },
    snapshot() {
      const inner = document.getElementById("chat-inner").getBoundingClientRect();
      const clicks = { ...window.__clicks };
      window.__clicks = {};
      return { innerTop: inner.top, innerBottom: inner.bottom, clicks };
    },
  };
</script></body></html>`;
}

function readRealAppStyles() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  if (!styles.trim()) throw new Error(`no <style> blocks found in ${INDEX_HTML}`);
  return styles;
}

async function compileMouseHelper(outDir) {
  const binary = path.join(outDir, "titlebar-drag-mouse");
  await execFileAsync("clang", [
    "-O2",
    "-o",
    binary,
    MOUSE_SOURCE,
    "-framework",
    "ApplicationServices",
  ]);
  return binary;
}

function samePosition(before, after) {
  return before.x === after.x && before.y === after.y;
}

async function runTitlebarDragGroup(outDir) {
  const results = [];
  const record = (check, pass, detail) => {
    results.push({ group: "titlebar-drag", check, pass, ...detail });
    process.stdout.write(`${pass ? "PASS" : "FAIL"} titlebar-drag/${check}\n`);
  };
  let win = null;
  let hardError = null;
  try {
    if (process.platform !== "darwin") {
      throw new Error("titlebar-drag: macOS only — native window drag needs CGEventPost");
    }
    const mouse = await compileMouseHelper(outDir);
    const fixturePath = path.join(outDir, "titlebar-drag-fixture.html");
    await fsp.writeFile(fixturePath, buildFixtureHtml(readRealAppStyles()));

    win = new BrowserWindow({
      ...BASE,
      width: 1000,
      height: 600,
      frame: false,
      show: false,
      backgroundColor: "#161616",
    });
    const evalPage = (code) => win.webContents.executeJavaScript(code);
    const bounds = () => {
      const current = win.getBounds();
      return { x: current.x, y: current.y };
    };
    const resetPosition = async () => {
      win.setPosition(BASE.x, BASE.y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    };
    const runMouse = async (args) => {
      await execFileAsync(mouse, args.map(String));
      await new Promise((resolve) => setTimeout(resolve, 220));
    };
    const mouseAt = (point) => ({ x: BASE.x + point.x, y: BASE.y + point.y });

    await win.loadFile(fixturePath);
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const scrollTop of [0, 1000]) {
      const snapshot = await evalPage(`window.__fixture.setScroll(${scrollTop})`);
      const crossesHeader = snapshot.innerTop < 36 && snapshot.innerBottom > 0;
      record(`scroll-${scrollTop}-content-crosses-header`, crossesHeader === (scrollTop === 1000), {
        innerTop: snapshot.innerTop,
        innerBottom: snapshot.innerBottom,
      });
      for (const point of DRAG_POINTS) {
        await resetPosition();
        const before = bounds();
        const from = mouseAt(point);
        await runMouse(["drag", from.x, from.y, from.x + DRAG_DELTA.x, from.y + DRAG_DELTA.y]);
        const after = bounds();
        const moved = after.x - before.x === DRAG_DELTA.x && after.y - before.y === DRAG_DELTA.y;
        record(`scroll-${scrollTop}-${point.check}`, moved, { before, after });
      }
      const chatPoint = { x: 625, y: 300 };
      await resetPosition();
      const before = bounds();
      const from = mouseAt(chatPoint);
      await runMouse(["drag", from.x, from.y, from.x + DRAG_DELTA.x, from.y + DRAG_DELTA.y]);
      const after = bounds();
      record(`scroll-${scrollTop}-chat-area-does-not-drag`, samePosition(before, after), {
        before,
        after,
      });
    }

    for (const point of CLICK_POINTS) {
      await resetPosition();
      const before = bounds();
      const from = mouseAt(point);
      await runMouse(["click", from.x, from.y]);
      const { clicks } = await evalPage("window.__fixture.snapshot()");
      const after = bounds();
      const clicked = clicks[point.id] === 1;
      const stillStationary = samePosition(before, after);
      record(point.check, clicked && stillStationary, { clicks, before, after });
      await runMouse(["drag", from.x, from.y, from.x + DRAG_DELTA.x, from.y + DRAG_DELTA.y]);
      const afterDrag = bounds();
      record(`${point.check}-does-not-drag`, samePosition(before, afterDrag), {
        before,
        after: afterDrag,
      });
    }

    for (const id of ["chat-link", "chat-code", "chat-file"]) {
      for (const y of [18, 50]) {
        await resetPosition();
        const point = await evalPage(`window.__fixture.placeControl(${JSON.stringify(id)}, ${y})`);
        const before = bounds();
        const from = mouseAt(point);
        await runMouse(["drag", from.x, from.y, from.x + DRAG_DELTA.x, from.y + DRAG_DELTA.y]);
        const after = bounds();
        record(
          `${id}-behind-header-${y}`,
          after.x - before.x === DRAG_DELTA.x && after.y - before.y === DRAG_DELTA.y,
          { before, after, point },
        );
      }
      await resetPosition();
      const point = await evalPage(`window.__fixture.placeControl(${JSON.stringify(id)}, 180)`);
      const before = bounds();
      const from = mouseAt(point);
      await evalPage("window.__fixture.snapshot()");
      await runMouse(["click", from.x, from.y]);
      const { clicks } = await evalPage("window.__fixture.snapshot()");
      const after = bounds();
      record(`${id}-visible-click`, clicks[id] === 1 && samePosition(before, after), {
        clicks,
        before,
        after,
        point,
      });
      await runMouse(["drag", from.x, from.y, from.x + DRAG_DELTA.x, from.y + DRAG_DELTA.y]);
      const afterDrag = bounds();
      record(`${id}-visible-does-not-drag`, samePosition(before, afterDrag), {
        before,
        after: afterDrag,
      });
    }

    const image = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, "titlebar-drag.png"), image.toPNG());
  } catch (error) {
    hardError = error;
    record("group-error", false, { reason: String(error?.message ?? error) });
  } finally {
    win?.destroy();
  }

  await fsp.writeFile(
    path.join(outDir, "titlebar-drag-results.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  const failed = results.filter((entry) => !entry.pass).map((entry) => entry.check);
  if (hardError || failed.length > 0) {
    throw new Error(`titlebar-drag group failed: ${failed.join(", ")}`, { cause: hardError });
  }
  return results;
}

module.exports = { runTitlebarDragGroup };
