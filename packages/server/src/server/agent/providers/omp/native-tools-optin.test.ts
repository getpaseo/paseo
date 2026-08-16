// The native-tools capability was a constant, so every omp provider advertised
// it and the only control was a daemon-wide flag named for MCP injection. A
// deployment running several omp providers in different roles needs the
// opposite: a worker-style provider holding no orchestration tools while a
// coordinator does, which is a per-provider decision. Turning MCP injection off
// must not remove native tools along with it.
import { describe, expect, it } from "vitest";

import { OmpAgentClient } from "./agent.js";
import { resolveOmpProviderParams } from "./provider-config.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as never;

function capabilitiesFor(providerParams: unknown): boolean {
  return new OmpAgentClient({ logger, providerParams }).capabilities.supportsNativePaseoTools;
}

describe("omp native Paseo tools are a per-provider decision", () => {
  it("defaults to enabled, which is the behaviour before the field existed", () => {
    expect(resolveOmpProviderParams({}).runtimeProviderParams.paseoTools).toBe(true);
    expect(capabilitiesFor(undefined)).toBe(true);
  });

  it("lets a provider opt out, so a Peer seat can hold no orchestration tools", () => {
    expect(resolveOmpProviderParams({ paseoTools: false }).runtimeProviderParams.paseoTools).toBe(
      false,
    );
    expect(capabilitiesFor({ paseoTools: false })).toBe(false);
  });

  it("keeps the opt-in explicit and independent of the other provider params", () => {
    expect(capabilitiesFor({ sessionDir: "/tmp/x", paseoTools: true })).toBe(true);
    expect(capabilitiesFor({ sessionDir: "/tmp/x" })).toBe(true);
  });

  it("rejects an unknown provider param rather than ignoring it", () => {
    expect(() => resolveOmpProviderParams({ paseoTool: true })).toThrow();
  });
});
