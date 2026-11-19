import { homedir } from "node:os";
import path from "node:path";

/**
 * The agent skill homes Paseo scans for the `/` menu and expands into prompts,
 * in precedence order.
 *
 * The shared `.agents` home comes first so a skill installed there wins over a
 * same-named copy in an agent-specific home. Every agent home Paseo knows is
 * scanned for every provider, matching how a user's skills are installed once
 * and consumed by several agents: Claude Code reads `~/.claude`, Codex reads
 * `~/.codex`, and ZCode (智谱) reads `~/.zcode`.
 *
 * Project-local roots come before the user's homes so a workspace's own skill
 * shadows the user's copy of the same name.
 */
export function resolveAgentSkillRoots(options: { cwd: string; home?: string }): readonly string[] {
  const home = options.home ?? homedir();
  return [
    path.join(options.cwd, ".agents", "skills"),
    path.join(options.cwd, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".zcode", "skills"),
  ];
}
