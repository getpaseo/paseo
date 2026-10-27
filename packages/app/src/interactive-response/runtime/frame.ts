import { renderArtifact } from "./render";
/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin; parent messages specify one. */
import { z } from "zod";
import { artifactMessage, artifactProgram } from "../artifact";

declare const ARTIFACT_WORKER: string;
const configSchema = z.object({
  session: z.string(),
  html: z.string().max(100000),
  initial: z.string().max(65536).optional(),
  disabled: z.boolean(),
  colorScheme: z.enum(["light", "dark"]).default("light"),
});
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("theme"), colorScheme: z.enum(["light", "dark"]) }),
  z.object({ type: z.literal("disabled"), disabled: z.boolean() }),
  z.object({ type: z.literal("flush"), id: z.number().int().nonnegative() }),
]);
const config = configSchema.parse(JSON.parse(document.getElementById("config")!.textContent!));
const root = document.getElementById("visual")!;
document.documentElement.style.colorScheme = config.colorScheme;
let disabled = config.disabled;
let failed = false;
let ready = false;
let messages = 0;
let windowStart = Date.now();
const workerUrl = URL.createObjectURL(new Blob([ARTIFACT_WORKER], { type: "text/javascript" }));
const worker = new Worker(workerUrl);
URL.revokeObjectURL(workerUrl);
let watchdog = setTimeout(fail, 10000);
function send(message: unknown) {
  const payload = { session: config.session, message };
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(payload));
  if (window.parent !== window) window.parent.postMessage(payload, "*");
}
function fail() {
  if (failed) return;
  failed = true;
  clearTimeout(watchdog);
  worker.terminate();
  root.replaceChildren();
  send({ type: "error" });
}
function render(markup: string) {
  renderArtifact(root, markup);
  root.inert = disabled;
}
const renderSchema = z.object({ type: z.literal("render"), markup: z.string().max(100000) });
worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (failed) return;
  try {
    if (Date.now() - windowStart > 1000) {
      windowStart = Date.now();
      messages = 0;
    }
    if (++messages > 120) throw new Error("Message limit");
    const renderMessage = renderSchema.safeParse(event.data);
    if (renderMessage.success) {
      render(renderMessage.data.markup);
      return;
    }
    const message = artifactMessage(event.data);
    if (message.type === "error") {
      fail();
      return;
    }
    if (message.type === "ready") {
      ready = true;
      clearTimeout(watchdog);
    }
    if (message.type === "flushed") clearTimeout(watchdog);
    send(message);
  } catch {
    fail();
  }
});
worker.addEventListener("error", fail);
function receive(raw: unknown) {
  if (failed) return;
  const parsed = z
    .object({ session: z.literal(config.session), command: commandSchema })
    .safeParse(raw);
  if (!parsed.success) return;
  const command = parsed.data.command;
  if (command.type === "disabled") {
    disabled = command.disabled;
    root.inert = disabled;
  } else if (command.type === "theme") {
    document.documentElement.style.colorScheme = command.colorScheme;
  } else if (ready) {
    worker.postMessage(command);
    watchdog = setTimeout(fail, 2000);
  }
}
window.__PASEO_ARTIFACT_RECEIVE__ = receive;
window.addEventListener("message", (event) => {
  if (event.source === window.parent) receive(event.data);
});
for (const type of ["click", "input", "change"] as const) {
  root.addEventListener(type, (event) => {
    if (disabled || failed || !ready) return;
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest("[id]");
    if (!target || !root.contains(target)) return;
    const control =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement;
    const value = control ? target.value : "";
    const checked = target instanceof HTMLInputElement && target.checked;
    worker.postMessage({ type: "event", event: { id: target.id, type, value, checked } });
  });
}
window.addEventListener("pagehide", () => {
  worker.terminate();
  clearTimeout(watchdog);
});
try {
  const program = artifactProgram(config.html);
  render(program.markup);
  worker.postMessage({ type: "init", scripts: program.scripts, initial: config.initial });
} catch {
  fail();
}

declare global {
  interface Window {
    __PASEO_ARTIFACT_RECEIVE__?: (message: unknown) => void;
  }
}
