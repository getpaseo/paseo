import type { AgentProfile } from "@getpaseo/protocol/messages";

export const roles = [
  "router",
  "planner",
  "plan-reviewer",
  "executor-standard",
  "executor-advanced",
  "final-review",
  "audit-economic",
  "audit-deep",
  "audit-security",
] as const;
export type Role = (typeof roles)[number];
export const profileId = (role: Role) => `paseo-workflow-${role}`;

export const profiles: AgentProfile[] = roles.map((role) => {
  let thinkingOptionId = "high";
  if (role === "router" || role === "audit-economic") thinkingOptionId = "low";
  if (role === "executor-standard") thinkingOptionId = "medium";
  const profile: AgentProfile = {
    id: profileId(role),
    name: `Workflow · ${role}`,
    provider: "codex",
    model: "gpt-5.4",
    modeId: "auto",
    thinkingOptionId,
  };
  if (role === "planner") {
    profile.featureValues = { plan_mode: true };
    profile.postApprovalModeId = "auto";
  }
  return profile;
});
