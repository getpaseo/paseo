import { expect, test } from "vitest";

import { buildAgentTeamRosterPrompt } from "./agent-team-roster.js";

test("lists each role with the exact create_agent parameters and the delegation rules", () => {
  const prompt = buildAgentTeamRosterPrompt({
    name: "full-stack",
    description: "Ship features end to end.",
    roles: [
      {
        name: "implementer",
        description: "Writes the code.",
        provider: "codex",
        model: "impl-model",
        modeId: "full-access",
        thinkingOptionId: "high",
        isolation: "worktree",
      },
      {
        name: "reviewer",
        description: "Reviews the diff.",
        provider: "claude",
        model: "review-model",
      },
      {
        name: "researcher",
        description: "Reads docs and the web.",
        provider: "gemini-acp",
        featureValues: { web: true },
        profile: "Gemini researcher",
        isolation: "local",
      },
    ],
  });

  expect(prompt).toBe(
    [
      'You lead the "full-stack" team. Ship features end to end.',
      "Delegate work by role instead of doing all of it yourself. Create each helper with the create_agent tool using its role's parameters:",
      "",
      "- implementer: Writes the code.",
      '  create_agent provider: "codex/impl-model", settings: {"modeId":"full-access","thinkingOptionId":"high"}, labels: {"paseo.team-role":"implementer"}',
      '  Isolation: call create_workspace with isolation "worktree" first, then pass its workspaceId to create_agent.',
      "- reviewer: Reviews the diff.",
      '  create_agent provider: "claude/review-model", labels: {"paseo.team-role":"reviewer"}',
      "- researcher: Reads docs and the web.",
      '  create_agent provider: "gemini-acp/<model>", settings: {"features":{"web":true}}, labels: {"paseo.team-role":"researcher"} (pick a gemini-acp model with inspect_provider)',
      "  Isolation: work in your current workspace (omit workspaceId).",
      "",
      "Rules:",
      "- Give each helper a self-contained prompt: the goal, the relevant files, the constraints, and what to report back. Helpers do not see this conversation.",
      "- When a role sets no modeId and its provider differs from yours, pass settings.modeId; inspect_provider lists the modes.",
      "- Use wait_for_agent when you need a helper's result before you continue. Keep notifyOnFinish on and keep working when you don't.",
      "- Keep the labels shown above: the paseo.team-role label is how teammates see each helper's role.",
      "- You stay responsible for the outcome: check each helper's result before you rely on it, and integrate it yourself.",
    ].join("\n"),
  );
});

test("omits the description sentence when the team has none", () => {
  const prompt = buildAgentTeamRosterPrompt({
    name: "solo",
    roles: [{ name: "worker", description: "Does it.", provider: "claude", model: "worker-model" }],
  });
  expect(prompt.split("\n")[0]).toBe('You lead the "solo" team.');
});

test("tells the chat to brief helpers on the peer tools only when peer messaging is on", () => {
  const roles = [{ name: "worker", description: "Does it.", provider: "claude", model: "m" }];
  const withPeers = buildAgentTeamRosterPrompt({ name: "pair", peerMessaging: true, roles });
  const withoutPeers = buildAgentTeamRosterPrompt({ name: "pair", roles });

  expect(withPeers).toContain(
    "- Peer messaging is on. Tell each helper in its initialPrompt: list_team_members shows the team (the member with isParent true is you), and send_team_message { agentId, message } reaches any member, you included.",
  );
  expect(withoutPeers).not.toContain("send_team_message");
  expect(withoutPeers).not.toContain("list_team_members");
  expect(withoutPeers).toContain('labels: {"paseo.team-role":"worker"}');
});
