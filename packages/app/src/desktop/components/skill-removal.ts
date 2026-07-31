import type { SkillSelection } from "@/desktop/daemon/skills-snapshot";

/**
 * Mirrors the host's delete rule: it converges to the desired set and removes
 * every managed directory outside it. Anything on disk that the draft will not
 * keep is deleted, whether or not the saved preference ever mentioned it — a
 * skill reinstalled by hand or restored by a sync is still deleted.
 */
export function skillsRemovedBySave({
  draft,
  available,
  installed,
}: {
  draft: SkillSelection;
  available: readonly string[];
  installed: readonly string[];
}): string[] {
  const kept = new Set(
    draft.mode === "all" ? available : available.filter((name) => draft.skills.includes(name)),
  );
  return installed.filter((name) => !kept.has(name));
}
