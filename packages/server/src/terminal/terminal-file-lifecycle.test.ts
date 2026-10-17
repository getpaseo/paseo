import { expect, test } from "vitest";
import { TerminalFileLifecycle, terminalFileKey } from "./terminal-file-lifecycle.js";

test("pending creation protects its hash and exit releases it", async () => {
  const lifecycle = new TerminalFileLifecycle();
  const pending = lifecycle.begin("a");
  expect(lifecycle.owner(terminalFileKey("a"))).toBe("a");
  expect(lifecycle.claimInactive(terminalFileKey("a"))).toBeUndefined();
  await pending;
  lifecycle.end("a");
  const release = lifecycle.claimInactive(terminalFileKey("a"));
  expect(release).toBeTypeOf("function");
  release!();
});

test("only reuse of a deleting ID waits; uncertainty prevents new deletion claims", async () => {
  const lifecycle = new TerminalFileLifecycle();
  const release = lifecycle.claimInactive(terminalFileKey("a"))!;
  let created = false;
  const creation = lifecycle.begin("a")!.then(() => {
    created = true;
    return undefined;
  });
  await lifecycle.begin("b");
  expect(created).toBe(false);
  expect(lifecycle.owner(terminalFileKey("a"))).toBe("a");
  release();
  await creation;
  expect(created).toBe(true);
  lifecycle.unavailable();
  expect(lifecycle.owner(terminalFileKey("missing"))).toBeUndefined();
  expect(lifecycle.claimInactive(terminalFileKey("missing"))).toBeUndefined();
});
