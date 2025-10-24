import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PersistedAgent {
  id: string;
  title: string;
  sessionId: string;
  createdAt: string;
  cwd: string;
}

export class AgentPersistence {
  private persistencePath: string;

  constructor() {
    // Store agents.json in the project root
    this.persistencePath = path.join(__dirname, "../../../agents.json");
  }

  /**
   * Load all persisted agents
   */
  async load(): Promise<PersistedAgent[]> {
    try {
      const data = await fs.readFile(this.persistencePath, "utf-8");
      return JSON.parse(data);
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