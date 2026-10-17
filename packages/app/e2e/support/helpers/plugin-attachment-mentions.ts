import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { expect } from "../fixtures";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { seedMockAgentWorkspace } from "./mock-agent";
import { pluginRequirements } from "./plugin-fixture";

const id = "attachment-mentions";
export const referenceText = "Session Budget planning\nDecision: Keep the context bounded.";

const sharedSource = `
import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";
export const search = defineRpc({ name: "sessions.search", input: z.object({ query: z.string() }), output: PluginAttachmentSearchPayloadSchema });
export const inspect = defineRpc({ name: "sessions.inspect", input: z.object({}), output: z.object({ queries: z.array(z.string()), completed: z.array(z.string()) }) });
export const source = defineAttachmentSource({ id: "sessions", title: "Session history", icon: "MessagesSquare", pickerTitle: "Reference a session", searchPlaceholder: "Search sessions", mentionPrefix: "sessions", search });
`;
const clientSource = `
import { source } from "./shared/source";
export default function contribute(client) {
  client.addAttachmentSource(source);
  client.addAttachmentSource({ ...source, id: "picker-only", mentionPrefix: undefined });
  return () => {};
}
`;
const serverSource = `
import { search, inspect } from "./shared/source";
const queries = [];
const completed = [];
export default function contribute(server) {
  server.handle(search, async ({ query }) => {
    queries.push(query);
    if (query === "fail") throw new Error("Reference search unavailable");
    if (query === "slow") await new Promise(resolve => setTimeout(resolve, 600));
    completed.push(query);
    const title = query === "slow" ? "Stale session" : "Budget planning";
    const items = query === "missing" ? [] : [{ id: "session-1", identifier: "SESSION-1", title, url: "https://example.com/sessions/1", text: ${JSON.stringify(referenceText)}, resourceType: "session" }];
    return { items };
  });
  server.handle(inspect, () => ({ queries, completed }));
  return () => {};
}
`;

const inspectionSchema = z.object({ queries: z.array(z.string()), completed: z.array(z.string()) });

type MentionPluginClient = Pick<
  DaemonClient,
  | "connect"
  | "close"
  | "getDaemonConfig"
  | "patchDaemonConfig"
  | "installDirectoryPlugin"
  | "removePlugin"
  | "disablePlugin"
  | "enablePlugin"
  | "invokePluginRpc"
  | "fetchAgentTimeline"
>;

export async function installAttachmentMentionPlugin() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-attachment-mentions-"));
  const client = await connectDaemonClient<MentionPluginClient>({
    clientIdPrefix: "attachment-mentions",
  });
  const previous = await client.getDaemonConfig();
  let installed = false;
  async function close() {
    if (installed) await client.removePlugin(id);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await mkdir(path.join(directory, "shared"));
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "shared/source.ts"), sharedSource);
    await writeFile(path.join(directory, "index.client.tsx"), clientSource);
    await writeFile(path.join(directory, "index.server.ts"), serverSource);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    const plugin = await client.installDirectoryPlugin(directory);
    installed = true;
    expect(plugin.status).toBe("running");
  } catch (error) {
    await close();
    throw error;
  }
  return {
    client,
    close,
    async inspect() {
      return inspectionSchema.parse(await client.invokePluginRpc(id, "sessions.inspect", {}));
    },
    disable: () => client.disablePlugin(id),
    enable: () => client.enablePlugin(id),
  };
}

export async function installAttachmentMentions() {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "attachment-mentions-",
    title: "Mention plugin resources",
    repo: { files: [{ path: "README.md", content: "Workspace file suggestions still work.\n" }] },
  });
  try {
    const plugin = await installAttachmentMentionPlugin();
    return {
      ...plugin,
      agent,
      async close() {
        await plugin.close();
        await agent.cleanup();
      },
    };
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}
