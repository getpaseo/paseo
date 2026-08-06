import { afterEach, describe, expect, it } from "vitest";
import { createPluginIframe } from "./frame.web";

/**
 * The document shell inserts the plugin's markup and re-creates its `<script>`
 * elements rather than letting the HTML parser see any of it, which is what
 * takes `<template shadowrootmode="closed">` away (see docs/plugins.md).
 *
 * That swaps a browser behaviour for our own code, so this file is the contract
 * a plugin author is owed: what still works, and what is documented as
 * different. Every case here was a silent failure at some point — a blank
 * plugin, a deleted data block, or scripts that stopped running halfway.
 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const REPORT = `function say(value) { parent.postMessage({ shell: 1, value: value }, "*"); }`;

/** Mount a plugin and collect everything it reports, once it goes quiet. */
async function run(html: string): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { shell?: number; value?: unknown };
    if (data?.shell === 1) {
      seen.push(data.value);
    }
  };
  window.addEventListener("message", onMessage);

  const iframe = createPluginIframe(`<script>${REPORT}</script>${html}`);
  document.body.appendChild(iframe);
  cleanups.push(() => {
    window.removeEventListener("message", onMessage);
    iframe.remove();
  });

  await new Promise((resolve) => setTimeout(resolve, 400));
  return seen;
}

describe("the plugin document shell", () => {
  it("runs inline scripts, in order", async () => {
    expect(await run(`<script>say("a")</script><div></div><script>say("b")</script>`)).toEqual([
      "a",
      "b",
    ]);
  });

  // The script-data tokenizer has three states. An unterminated `<!--` moves it
  // to "escaped" and a later `<script` to "double escaped", where the shell's
  // own `</script>` stops ending the element — the document becomes one
  // unterminated script and the plugin renders nothing, silently.
  it("survives plugin content that would derail the tokenizer", async () => {
    expect(await run(`<script>var s = "<!--"; say("ran")</script>`)).toEqual(["ran"]);
    expect(await run(`<div data-x="<!-- x"></div><script>say("attr")</script>`)).toEqual(["attr"]);
    expect(await run(`<script>say("</scr" + "ipt> <script>")</script>`)).toEqual([
      "</script> <script>",
    ]);
  });

  it("keeps the attributes a script was written with", async () => {
    expect(
      await run(
        `<script id="mine" data-config="hello">say(document.currentScript.id + ":" + document.currentScript.dataset.config)</script>`,
      ),
    ).toEqual(["mine:hello"]);
  });

  it("leaves data blocks alone instead of executing them", async () => {
    const seen = await run(
      `<script type="application/json" id="data">{"a":1}</script>
       <script>say(JSON.parse(document.getElementById("data").textContent).a)</script>`,
    );
    expect(seen).toEqual([1]);
  });

  // A hand-rolled pattern for "is this JavaScript" drops types a document parse
  // runs, and an inert `<script>` reports nothing anywhere. The list is the
  // spec's legacy JavaScript MIME types; `type` is trimmed because the parser
  // trims. `text/javascript;charset=utf-8` is excluded on purpose — Chromium
  // refuses it in a real parse too.
  it("runs every script type the parser would", async () => {
    const types = [
      "",
      "text/javascript",
      " text/javascript ",
      "TEXT/JavaScript",
      "application/javascript",
      "application/x-javascript",
      "text/jscript",
      "text/livescript",
      "text/javascript1.5",
    ];
    const seen = await run(
      types.map((type) => `<script type="${type}">say("${type.trim()}")</script>`).join(""),
    );
    expect(seen).toEqual(types.map((type) => type.trim()));
  });

  it("runs a module, after the classic scripts", async () => {
    expect(
      await run(`<script type="module">export const x = 1; say("module")</script>
                 <script>say("classic")</script>`),
    ).toEqual(["classic", "module"]);
  });

  it("keeps running after a script removes a later one", async () => {
    const seen = await run(
      `<script>document.getElementById("kill").remove(); say("first")</script>
       <script id="kill">say("killed")</script>
       <script>say("third")</script>`,
    );
    expect(seen).toEqual(["first", "third"]);
  });

  it("keeps running after a script throws", async () => {
    expect(
      await run(
        `<script>say("before"); throw new Error("x")</script><script>say("after")</script>`,
      ),
    ).toEqual(["before", "after"]);
  });

  it("does not run scripts inside a template", async () => {
    expect(
      await run(
        `<template><script>say("template")</script></template><script>say("real")</script>`,
      ),
    ).toEqual(["real"]);
  });

  // The shell's own script is appended to `<body>` before the plugin's markup,
  // so leaving it there shifts every `:first-child`, `:nth-child`, and
  // `body.children[0]` the plugin wrote by one.
  it("takes its own script back out of the document", async () => {
    expect(
      // After the loop: the plugin's own scripts run inside it, while the shell
      // script is necessarily still in the tree running them.
      await run(
        // Split so the needle is not sitting in the plugin's own script text.
        `<script>setTimeout(function () { say(document.body.innerHTML.indexOf("insertAdjacent" + "HTML") === -1) }, 0)</script>`,
      ),
    ).toEqual([true]);
  });

  // The plugin's own markup starts at `body`'s first child, not after a shell
  // script — otherwise every `:first-child`, `:nth-child`, and
  // `body.children[0]` the plugin wrote is off by one.
  it("leaves the plugin's own element first in the body", async () => {
    const iframe = createPluginIframe(
      `<div id="first"></div><script>setTimeout(function () { parent.postMessage({ shell: 1, value: document.body.firstElementChild.id }, "*") }, 0)</script>`,
    );
    const seen: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { shell?: number; value?: unknown };
      if (data?.shell === 1) {
        seen.push(data.value);
      }
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual(["first"]);
  });
});
