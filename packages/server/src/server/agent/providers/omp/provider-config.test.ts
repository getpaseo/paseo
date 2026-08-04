import pino from "pino";
import { describe, expect, test } from "vitest";

import { OmpAgentClient } from "./agent.js";
import { resolveOmpProviderParams } from "./provider-config.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

function createClient(providerParams: unknown, omp: FakeOmp): OmpAgentClient {
  return new OmpAgentClient({
    logger: pino({ level: "silent" }),
    runtime: omp,
    providerParams,
  });
}

describe("resolveOmpProviderParams guardrails", () => {
  test("maps model and configOverlay into guardrail params", () => {
    const { guardrailParams } = resolveOmpProviderParams({
      model: "kimi-code/k3-256k",
      configOverlay: "/etc/paseo/omp-guardrails.yml",
    });
    expect(guardrailParams).toEqual({
      defaultModel: "kimi-code/k3-256k",
      configOverlay: "/etc/paseo/omp-guardrails.yml",
    });
  });

  test("omits guardrails when params are absent", () => {
    expect(resolveOmpProviderParams(undefined).guardrailParams).toEqual({});
    expect(resolveOmpProviderParams({}).guardrailParams).toEqual({});
  });
});

describe("omp launch guardrails", () => {
  test("applies params.model when the request picks no model", async () => {
    const omp = new FakeOmp();
    const client = createClient({ model: "kimi-code/k3-256k" }, omp);
    await client.createSession({ provider: "omp", cwd: "/tmp/work" });

    const argv = omp.recordedLaunches[0]!.argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("kimi-code/k3-256k");
  });

  test("an explicit request model beats params.model", async () => {
    const omp = new FakeOmp();
    const client = createClient({ model: "kimi-code/k3-256k" }, omp);
    await client.createSession({
      provider: "omp",
      cwd: "/tmp/work",
      model: "openai/gpt-5.6-luna",
    });

    const argv = omp.recordedLaunches[0]!.argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("openai/gpt-5.6-luna");
  });

  test("passes params.configOverlay as --config on create", async () => {
    const omp = new FakeOmp();
    const client = createClient({ configOverlay: "/etc/paseo/omp-guardrails.yml" }, omp);
    await client.createSession({ provider: "omp", cwd: "/tmp/work" });

    const argv = omp.recordedLaunches[0]!.argv;
    expect(argv[argv.indexOf("--config") + 1]).toBe("/etc/paseo/omp-guardrails.yml");
  });

  test("resume carries the overlay but not the default model", async () => {
    const omp = new FakeOmp();
    const client = createClient(
      { model: "kimi-code/k3-256k", configOverlay: "/etc/paseo/omp-guardrails.yml" },
      omp,
    );
    await client.resumeSession({
      provider: "omp",
      sessionId: "session-1",
      nativeHandle: "/tmp/session.jsonl",
      metadata: { cwd: "/tmp/work" },
    });

    const argv = omp.recordedLaunches[0]!.argv;
    expect(argv[argv.indexOf("--config") + 1]).toBe("/etc/paseo/omp-guardrails.yml");
    // A resume restores the model the session itself persisted; the provider
    // default would silently override it, so it must not appear.
    expect(argv).not.toContain("--model");
  });

  test("launch is unchanged when no guardrails are configured", async () => {
    const omp = new FakeOmp();
    const client = createClient(undefined, omp);
    await client.createSession({ provider: "omp", cwd: "/tmp/work" });

    const argv = omp.recordedLaunches[0]!.argv;
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--config");
  });
});
