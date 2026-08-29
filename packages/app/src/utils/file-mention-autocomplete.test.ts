import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import {
  applyAgentMentionReplacement,
  applyFileMentionReplacement,
  filterAndRankAgentMentionCandidates,
  findActiveFileMention,
  formatQuotedFileMentionPath,
  type AgentMentionCandidate,
} from "./file-mention-autocomplete";

function agentCandidate(
  input: Partial<AgentMentionCandidate> & Pick<AgentMentionCandidate, "id">,
): AgentMentionCandidate {
  return {
    id: input.id,
    title: input.title ?? input.id,
    cwd: input.cwd ?? "/workspace",
    provider: input.provider ?? "codex",
    archivedAt: input.archivedAt ?? null,
    labels: input.labels ?? {},
    projectPlacement: input.projectPlacement ?? null,
  };
}

function projectPlacement(input: {
  workspaceName?: string | null;
  projectName?: string;
  currentBranch?: string | null;
}): ProjectPlacementPayload {
  return {
    projectKey: "project-key",
    projectName: input.projectName ?? "Paseo",
    workspaceName: input.workspaceName ?? "Paseo workspace",
    checkout: {
      cwd: "/repo/paseo",
      isGit: true,
      currentBranch: input.currentBranch ?? "main",
      remoteUrl: "https://github.com/getpaseo/paseo.git",
      worktreeRoot: "/repo/paseo",
      isPaseoOwnedWorktree: false,
      mainRepoRoot: "/repo/paseo",
    },
  };
}

describe("findActiveFileMention", () => {
  it("detects mentions at the start of input", () => {
    const mention = findActiveFileMention({
      text: "@src/components",
      cursorIndex: "@src/components".length,
    });
    expect(mention).toEqual({
      start: 0,
      end: "@src/components".length,
      query: "src/components",
    });
  });

  it("detects mentions in the middle of input using cursor position", () => {
    const text = 'read "@src/com" before merging';
    const cursorIndex = text.indexOf('"') + 9;
    const mention = findActiveFileMention({
      text,
      cursorIndex,
    });
    expect(mention).toEqual({
      start: text.indexOf("@"),
      end: cursorIndex,
      query: "src/com",
    });
  });

  it("returns null when cursor is outside the mention token", () => {
    const text = "please review @src/components now";
    const mention = findActiveFileMention({
      text,
      cursorIndex: text.length,
    });
    expect(mention).toBeNull();
  });

  it("returns null when @ at start is followed by a delimiter", () => {
    const mention = findActiveFileMention({
      text: "@ ",
      cursorIndex: 2,
    });
    expect(mention).toBeNull();
  });
});

describe("formatQuotedFileMentionPath", () => {
  it("quotes workspace-relative paths using file mention escaping", () => {
    expect(formatQuotedFileMentionPath('src/changed "file".ts')).toBe(
      '"src/changed \\"file\\".ts"',
    );
  });
});

describe("applyFileMentionReplacement", () => {
  it("replaces only the active @query segment with a quoted relative path", () => {
    const text = "open @src/com next";
    const next = applyFileMentionReplacement({
      text,
      mention: { start: 5, end: 13, query: "src/com" },
      relativePath: "src/components/chat.tsx",
    });
    expect(next).toBe('open "src/components/chat.tsx" next');
  });

  it("escapes double quotes in replacement path", () => {
    const text = "@foo";
    const next = applyFileMentionReplacement({
      text,
      mention: { start: 0, end: 4, query: "foo" },
      relativePath: 'src/"quoted".ts',
    });
    expect(next).toBe('"src/\\"quoted\\".ts"');
  });
});

describe("applyAgentMentionReplacement", () => {
  it("removes an inline @query without leaving doubled whitespace", () => {
    const text = "review @oauth-agent before merging";
    const next = applyAgentMentionReplacement({
      text,
      mention: { start: 7, end: 19, query: "oauth-agent" },
    });
    expect(next).toBe("review before merging");
  });

  it("removes adjacent whitespace when the @query starts or ends the prompt", () => {
    expect(
      applyAgentMentionReplacement({
        text: "@oauth-agent before merging",
        mention: { start: 0, end: 12, query: "oauth-agent" },
      }),
    ).toBe("before merging");
    expect(
      applyAgentMentionReplacement({
        text: "review @oauth-agent",
        mention: { start: 7, end: 19, query: "oauth-agent" },
      }),
    ).toBe("review");
  });
});

describe("filterAndRankAgentMentionCandidates", () => {
  it("excludes the current, archived, delegated, and duplicate agents", () => {
    const candidates = [
      agentCandidate({ id: "current", title: "Current agent" }),
      agentCandidate({ id: "archived", title: "Archived agent", archivedAt: new Date() }),
      agentCandidate({
        id: "delegated",
        title: "Delegated agent",
        labels: { [PARENT_AGENT_ID_LABEL]: "parent-agent" },
      }),
      agentCandidate({ id: "eligible", title: "Eligible agent" }),
      agentCandidate({ id: "eligible", title: "Duplicate eligible agent" }),
    ];

    expect(
      filterAndRankAgentMentionCandidates(candidates, "", "current").map((agent) => agent.id),
    ).toEqual(["eligible"]);
  });

  it("matches agent titles, workspace paths, and ids before ranking the best title match", () => {
    const candidates = [
      agentCandidate({ id: "fix-auth-later", title: "Fix auth later" }),
      agentCandidate({ id: "fix-auth", title: "Fix auth" }),
      agentCandidate({ id: "agent-123", title: "Unrelated", cwd: "/repo/auth-service" }),
    ];

    expect(
      filterAndRankAgentMentionCandidates(candidates, "auth", "current").map((agent) => agent.id),
    ).toEqual(["fix-auth", "fix-auth-later", "agent-123"]);
  });

  it("retains daemon history matches found through workspace, project, and branch", () => {
    const candidates = [
      agentCandidate({
        id: "agent-a",
        title: "Alpha",
        cwd: "/repo/alpha",
        projectPlacement: projectPlacement({ workspaceName: "Wombat workspace" }),
      }),
      agentCandidate({
        id: "agent-b",
        title: "Beta",
        cwd: "/repo/beta",
        projectPlacement: projectPlacement({ projectName: "Peregrine project" }),
      }),
      agentCandidate({
        id: "agent-c",
        title: "Gamma",
        cwd: "/repo/gamma",
        projectPlacement: projectPlacement({ currentBranch: "feature/otter-search" }),
      }),
    ];

    expect(
      filterAndRankAgentMentionCandidates(candidates, "wombat", "current").map((agent) => agent.id),
    ).toEqual(["agent-a"]);
    expect(
      filterAndRankAgentMentionCandidates(candidates, "peregrine", "current").map(
        (agent) => agent.id,
      ),
    ).toEqual(["agent-b"]);
    expect(
      filterAndRankAgentMentionCandidates(candidates, "otter", "current").map((agent) => agent.id),
    ).toEqual(["agent-c"]);
  });
});
