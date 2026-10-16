import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createPaseoToolCatalog } from "../../tools/paseo-tools.js";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import { OpenCodeBridge } from "./bridge.js";
import { ScheduleService } from "../../../schedule/service.js";

test("invalid create_agent input and malformed requests return actionable client errors", async () => {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-7045-"));
  const logger = createTestLogger();
  const providerSnapshotManager = new ProviderSnapshotManager({ logger });
  const agentManager = new AgentManager({ logger });
  const agentStorage = new AgentStorage(paseoHome, logger);
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected workspace or agent creation");
  };
  const scheduleService = new ScheduleService({
    paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent: unused,
    createDirectoryWorkspace: unused,
    createPaseoWorktreeWorkspace: unused,
    archiveWorkspace: unused,
    runner: async () => ({ agentId: null, output: "done" }),
  });
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage,
    scheduleService,
    providerSnapshotManager,
    logger,
  });
  const bridge = new OpenCodeBridge({ paseoHome, logger });
  try {
    await bridge.start();
    bridge.setManifestCatalog(catalog);
    bridge.bindSession({ sessionId: "diagnosis", env: {}, tools: catalog });
    const config = JSON.parse(bridge.decorateServerEnv({}).OPENCODE_CONFIG_CONTENT);
    const { baseUrl, token } = config.plugin[0][1];
    const completed = await scheduleService.create({
      prompt: "Run once",
      cadence: { type: "cron", expression: "0 0 * * *" },
      target: { type: "new-agent", config: { provider: "codex", cwd: paseoHome } },
      maxRuns: 1,
      runOnCreate: true,
    });
    await scheduleService.tick();
    expect((await scheduleService.inspect(completed.id)).status).toBe("completed");
    const manifest = await fetch(`${baseUrl}/_internal/opencode/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { tools } = await manifest.json();
    expect(
      tools.find((tool: { name: string }) => tool.name === "create_agent").inputSchema.properties,
    ).not.toHaveProperty("background");
    expect(
      tools.find((tool: { name: string }) => tool.name === "update_schedule").inputSchema
        .properties,
    ).not.toHaveProperty("every");
    const observed = [];
    for (const [tool, body, expected] of [
      [
        "create_agent",
        JSON.stringify({ title: "Probe", provider: "opencode", initialPrompt: "Reply OK" }),
        400,
      ],
      ["create_agent", "{", 400],
      ["nonexistent_tool", "{}", 404],
      ["inspect_schedule", JSON.stringify({ id: "missing" }), 400],
      ...["pause_schedule", "resume_schedule", "run_schedule_once"].map(
        (action) => [action, JSON.stringify({ id: completed.id }), 400] as const,
      ),
      [
        "create_schedule",
        JSON.stringify({ prompt: "Probe", provider: "codex", cron: "not-a-cron" }),
        400,
      ],
      [
        "create_schedule",
        JSON.stringify({
          prompt: "Probe",
          provider: "codex",
          cron: "0 0 * * *",
          timezone: "Mars/Phobos",
        }),
        400,
      ],
      ["update_schedule", JSON.stringify({ id: completed.id, name: "" }), 400],
      ["update_schedule", JSON.stringify({ id: completed.id, cron: "0 0 30 2 *" }), 400],
      ["update_schedule", JSON.stringify({ id: completed.id, expiresIn: "not-a-duration" }), 400],
    ] as const) {
      const response = await fetch(
        `${baseUrl}/_internal/opencode/sessions/diagnosis/tools/${tool}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
        },
      );
      observed.push({
        tool,
        body,
        expected,
        status: response.status,
        payload: await response.json(),
      });
    }

    for (const result of observed) expect(result.status, result.body).toBe(result.expected);
    expect(observed[3].payload).toEqual({ error: "Schedule not found: missing" });
    for (const result of observed.slice(4, 7))
      expect(result.payload).toEqual({ error: `Schedule ${completed.id} is already completed` });
    for (const [index, field] of [
      [7, "cron"],
      [8, "timezone"],
      [9, "name"],
      [10, "cron"],
      [11, "expiresIn"],
    ] as const) {
      expect(observed[index].payload).toMatchObject({
        error: "Invalid tool input",
        issues: expect.arrayContaining([expect.objectContaining({ path: [field] })]),
      });
    }
    expect(observed[0].payload).toMatchObject({
      error: "Invalid tool input",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["provider"],
          message: expect.stringContaining("provider/model"),
        }),
      ]),
    });
  } finally {
    await bridge.close();
    await providerSnapshotManager.shutdown();
    await rm(paseoHome, { recursive: true, force: true });
  }
});
