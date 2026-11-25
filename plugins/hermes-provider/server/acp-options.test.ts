import { describe, expect, it } from "vitest";
import { hermesAcpOptions } from "./acp-options.js";

describe("Hermes ACP options", () => {
  it("allows for a concurrent cold start", () => {
    // Four concurrent `hermes acp` viewers measured 8-12 s to initialize on Windows;
    // the 10 s default intermittently failed agent creation with "did not initialize".
    expect(hermesAcpOptions.startupTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});
