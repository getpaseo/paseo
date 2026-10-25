import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { artifactState, artifactMessage } from "../artifact";

export interface RuntimeOutput {
  render(markup: string): void;
  state(value: string): void;
  failed(): void;
}
export interface ArtifactEvent {
  id: string;
  type: "click" | "input" | "change";
  value: string;
  checked: boolean;
}

// Only serialized values cross the interpreter boundary; never expose DOM objects
// or browser functions to code produced by an agent.
const bootstrap = `
(() => {
const callbacks = new Map();
const timers = new Map();
let nextTimer = 0;
let current = JSON.parse(__initial);
globalThis.paseo = Object.freeze({
  getState: () => JSON.parse(JSON.stringify(current.state)),
  setState: value => { const next = JSON.stringify({state:value, proposal:current.proposal}); __output("state",next); current=JSON.parse(next); },
  propose: text => { const next = JSON.stringify({state:current.state, proposal:text}); __output("state",next); current=JSON.parse(next); },
  render: html => __output("render",html),
  on: (id,type,fn) => { if(typeof id!=="string" || id.length>64 || !["click","input","change"].includes(type) || typeof fn!=="function") throw Error("Invalid event"); callbacks.set(type+":"+id,fn); }
});
globalThis.setTimeout = (fn,delay=0) => { if(typeof fn!=="function" || timers.size>=16) throw Error("Timer limit"); const id=++nextTimer; __schedule(id,delay); timers.set(id,fn); return id; };
globalThis.clearTimeout = id => { timers.delete(id); __cancel(id); };
globalThis.requestAnimationFrame = fn => setTimeout(()=>fn(Date.now()),32);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.__dispatch = event => { const fn=callbacks.get(event.type+":"+event.id); if(fn) fn(event); };
globalThis.__tick = id => { const fn=timers.get(id); timers.delete(id); if(fn) fn(); };
})();
`;

export async function createArtifactVM(initial: string | undefined, output: RuntimeOutput) {
  const bounded = newVariant(variant, {
    wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
  });
  const module = await newQuickJSWASMModuleFromVariant(bounded);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  let deadline = 0;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  let disposed = false;
  let count = 0;
  let windowStart = Date.now();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    context.dispose();
    runtime.dispose();
  }
  function evaluate(code: string, budget = 100) {
    if (disposed) throw new Error("Runtime closed");
    deadline = Date.now() + budget;
    const result = context.evalCode(code);
    if (result.error) {
      result.error.dispose();
      throw new Error("Visual execution failed");
    }
    result.value.dispose();
    const jobs = runtime.executePendingJobs(100);
    if (jobs.error) {
      jobs.error.dispose();
      throw new Error("Visual task failed");
    }
    if (runtime.hasPendingJob()) throw new Error("Visual task limit");
  }
  function fail() {
    output.failed();
    dispose();
  }
  function rateLimit() {
    if (Date.now() - windowStart > 1000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 120) throw new Error("Visual message limit");
  }
  context
    .newFunction("output", (kind, value) => {
      rateLimit();
      const text = context.getString(value);
      if (context.getString(kind) === "render") {
        if (text.length > 100000) throw new Error("Visual too large");
        output.render(text);
      } else if (context.getString(kind) === "state") {
        artifactMessage({ type: "state", value: text });
        output.state(text);
      } else throw new Error("Invalid visual output");
    })
    .consume((handle) => context.setProp(context.global, "__output", handle));
  context
    .newFunction("schedule", (idHandle, delayHandle) => {
      const id = context.getNumber(idHandle);
      const delay = context.getNumber(delayHandle);
      if (
        timers.size >= 16 ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        timers.has(id) ||
        !Number.isFinite(delay)
      )
        throw new Error("Timer limit");
      const timer = setTimeout(
        () => {
          timers.delete(id);
          try {
            evaluate(`__tick(${id})`);
          } catch {
            fail();
          }
        },
        Math.max(32, Math.min(60000, delay)),
      );
      timers.set(id, timer);
    })
    .consume((handle) => context.setProp(context.global, "__schedule", handle));
  context
    .newFunction("cancel", (idHandle) => {
      const id = context.getNumber(idHandle);
      clearTimeout(timers.get(id));
      timers.delete(id);
    })
    .consume((handle) => context.setProp(context.global, "__cancel", handle));
  context
    .newString(JSON.stringify(artifactState(initial)))
    .consume((handle) => context.setProp(context.global, "__initial", handle));
  try {
    evaluate(bootstrap, 500);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    run(scripts: string[]) {
      try {
        evaluate(scripts.join("\n;\n"), 500);
      } catch (error) {
        dispose();
        throw error;
      }
    },
    event(event: ArtifactEvent) {
      try {
        rateLimit();
        evaluate(`__dispatch(${JSON.stringify(event)})`);
      } catch (error) {
        dispose();
        throw error;
      }
    },
    pause() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    dispose,
  };
}
