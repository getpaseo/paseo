import path from "node:path";
import os from "node:os";
import { app } from "electron";

export function getBundledSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "skills");
  }
  return path.join(__dirname, "..", "..", "..", "..", "..", "skills");
}

export function getAgentsSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

export function getCodexSkillsDir(): string {
  return path.join(os.homedir(), ".codex", "skills");
}
