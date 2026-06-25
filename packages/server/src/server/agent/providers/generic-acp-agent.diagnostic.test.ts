import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { buildVersionProbeCommand, GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient diagnostics", () => {
  test("probes npx-backed agent packages instead of npx itself", () => {
    expect(buildVersionProbeCommand(["npx", "-y", "@google/gemini-cli@0.41.1", "--acp"])).toEqual({
      command: "npx",
      args: ["-y", "@google/gemini-cli@0.41.1", "--version"],
    });

    expect(buildVersionProbeCommand(["pnpm", "dlx", "@agent/foo@1.2.3", "--acp"])).toEqual({
      command: "pnpm",
      args: ["dlx", "@agent/foo@1.2.3", "--version"],
    });
  });

  test("reports command, binary, and version command without spawning ACP", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, "acp"],
      providerId: "cursor",
      label: "Cursor",
    });

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Cursor (ACP)");
    expect(diagnostic).toContain("Provider ID: cursor");
    expect(diagnostic).toContain(`Configured command: ${process.execPath} acp`);
    expect(diagnostic).toContain(`Launcher binary: ${process.execPath}`);
    expect(diagnostic).toContain(`Version command: ${process.execPath} --version`);
    expect(diagnostic).not.toContain("ACP initialize");
    expect(diagnostic).not.toContain("ACP session/new");
    expect(diagnostic).not.toContain("Models:");
    expect(diagnostic).not.toContain("Modes:");
    expect(diagnostic).not.toContain("Status:");
  });
});
