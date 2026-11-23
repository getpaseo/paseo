import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillTargets } from "./operations.js";

export function resolveBundledSkillsDir(moduleUrl: string | URL = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "skills"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "skills"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveSkillTargets(home: string = os.homedir()): SkillTargets {
  return {
    sourceDir: resolveBundledSkillsDir(),
    // Append new install roots to the end — transaction backups reference roots
    // by index, so existing positions must remain stable across upgrades.
    installDirs: [
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".gemini", "config", "skills"),
    ],
    codexDir: path.join(home, ".codex", "skills"),
  };
}
