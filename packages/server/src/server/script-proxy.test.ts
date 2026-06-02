import { describe, expect, it } from "vitest";
import {
  createScriptProxyMiddleware,
  createScriptProxyUpgradeHandler,
  findFreePort,
  ScriptRouteStore,
} from "./script-proxy.js";

describe("script-proxy compatibility re-exports", () => {
  it("keeps the legacy imports available", () => {
    expect(createScriptProxyMiddleware).toEqual(expect.any(Function));
    expect(createScriptProxyUpgradeHandler).toEqual(expect.any(Function));
    expect(findFreePort).toEqual(expect.any(Function));
    expect(new ScriptRouteStore()).toEqual(expect.any(Object));
  });
});
