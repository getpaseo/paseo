import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Zod schema for agent options (discriminated union)
export const AgentOptionsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claude"),
    sessionId: z.string(), // Claude's internal session ID
  }),
  // Add more agent types here in the future
]);

export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

// Zod schema for persisted agent
export const PersistedAgentSchema = z.object({
  id: z.string(),
  title: z.string(),
  sessionId: z.string(), // ACP protocol session ID (for backward compatibility)
  options: AgentOptionsSchema, // Required field with discriminated union
  createdAt: z.string(),
  cwd: z.string(),
});

export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

export class AgentPersistence {
  private persistencePath: string;

  constructor() {
    // Store agents.json in the project root
    this.persistencePath = path.join(__dirname, "../../../agents.json");
  }

  /**
   * Load all persisted agents with Zod validation
   */
  async load(): Promise<PersistedAgent[]> {
    try {
      const data = await fs.readFile(this.persistencePath, "utf-8");
      const parsed = JSON.parse(data);

      // Validate each agent with Zod schema
      const agents: PersistedAgent[] = [];
      for (const agent of parsed) {
        try {
          const validated = PersistedAgentSchema.parse(agent);
          agents.push(validated);
        } catch (zodError) {
          console.error(`[AgentPersistence] Invalid agent data for ${agent.id}:`, zodError);
          // Skip invalid agents
        }
      }

      return agents;
    } catch (error) {
      // File doesn't exist or is invalid, return empty array
      console.log("[AgentPersistence] No existing agents found or file is invalid");
      return [];
    }
  }

  /**
   * Save agents to disk
   */
  async save(agents: PersistedAgent[]): Promise<void> {
    try {
      await fs.writeFile(
        this.persistencePath,
        JSON.stringify(agents, null, 2),
        "utf-8"
      );
      console.log(`[AgentPersistence] Saved ${agents.length} agents to disk`);
    } catch (error) {
      console.error("[AgentPersistence] Failed to save agents:", error);
      throw error;
    }
  }

  /**
   * Add or update an agent
   */
  async upsert(agent: PersistedAgent): Promise<void> {
    const agents = await this.load();
    const existingIndex = agents.findIndex((a) => a.id === agent.id);

    if (existingIndex >= 0) {
      agents[existingIndex] = agent;
      console.log(`[AgentPersistence] Updated agent ${agent.id}`);
    } else {
      agents.push(agent);
      console.log(`[AgentPersistence] Added new agent ${agent.id}`);
    }

    await this.save(agents);
  }

  /**
   * Remove an agent
   */
  async remove(agentId: string): Promise<void> {
    const agents = await this.load();
    const filtered = agents.filter((a) => a.id !== agentId);

    if (filtered.length < agents.length) {
      await this.save(filtered);
      console.log(`[AgentPersistence] Removed agent ${agentId}`);
    }
  }

  /**
   * Update agent title
   */
  async updateTitle(agentId: string, title: string): Promise<void> {
    const agents = await this.load();
    const agent = agents.find((a) => a.id === agentId);

    if (agent) {
      agent.title = title;
      await this.save(agents);
      console.log(`[AgentPersistence] Updated title for agent ${agentId}: "${title}"`);
    }
  }
}