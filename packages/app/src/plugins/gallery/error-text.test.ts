import { describe, expect, it } from "vitest";
import { pluginErrorText } from "./error-text";

describe("pluginErrorText", () => {
  it("shows the daemon's text without the request details an RPC error adds", () => {
    const rpcError = Object.assign(
      new Error(
        "Registry credentials require HTTPS requestType=plugin.registry.list.request code=handler_error",
      ),
      { userMessage: "Registry credentials require HTTPS" },
    );
    expect(pluginErrorText(rpcError)).toBe("Registry credentials require HTTPS");
  });

  it("shows any other error's message", () => {
    expect(pluginErrorText(new Error("Socket closed"))).toBe("Socket closed");
    expect(pluginErrorText("offline")).toBe("offline");
  });
});
