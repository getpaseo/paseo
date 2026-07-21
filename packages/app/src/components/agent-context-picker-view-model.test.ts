import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  filterAgentContextAttachmentsForServer,
  hasForeignAgentContextAttachments,
  type UserComposerAttachment,
} from "@/attachments/types";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  appendAgentContextAttachmentFromMention,
  appendAgentContextAttachmentFromPicker,
  buildAgentContextSourceGroups,
  isAgentContextAttachment,
  isAgentContextSourceSelectionDisabled,
  MAX_AGENT_CONTEXT_ATTACHMENTS,
} from "./agent-context-picker-view-model";

const TIMESTAMP = new Date("2026-07-22T10:00:00.000Z");

function placement(input: {
  projectKey: string;
  projectName?: string;
  workspaceName?: string | null;
}): ProjectPlacementPayload {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName ?? "Paseo",
    workspaceName: input.workspaceName ?? "Paseo workspace",
    checkout: {
      cwd: "/repo/paseo",
      isGit: true,
      currentBranch: "main",
      remoteUrl: "https://github.com/getpaseo/paseo.git",
      worktreeRoot: "/repo/paseo",
      isPaseoOwnedWorktree: false,
      mainRepoRoot: "/repo/paseo",
    },
  };
}

function agent(input: Partial<AggregatedAgent> & Pick<AggregatedAgent, "id">): AggregatedAgent {
  const { id, ...overrides } = input;
  return {
    serverId: "server-a",
    serverLabel: "Local host",
    id,
    title: "Agent",
    provider: "codex",
    status: "idle",
    lastActivityAt: TIMESTAMP,
    cwd: "/repo/paseo",
    workspaceId: "workspace-a",
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: TIMESTAMP,
    labels: {},
    projectPlacement: null,
    ...overrides,
  };
}

function groupAgentIds(groups: ReturnType<typeof buildAgentContextSourceGroups>) {
  return groups.map((group) => ({ kind: group.kind, ids: group.agents.map((entry) => entry.id) }));
}

describe("buildAgentContextSourceGroups", () => {
  it("keeps only active top-level agents from the current host", () => {
    const groups = buildAgentContextSourceGroups({
      agents: [
        agent({ id: "current" }),
        agent({ id: "eligible" }),
        agent({ id: "other-host", serverId: "server-b" }),
        agent({ id: "archived", archivedAt: new Date("2026-07-21T10:00:00.000Z") }),
        agent({ id: "delegated", labels: { [PARENT_AGENT_ID_LABEL]: "current" } }),
      ],
      serverId: "server-a",
      workspaceId: "workspace-a",
      currentAgentId: "current",
      query: "",
    });

    expect(groupAgentIds(groups)).toEqual([{ kind: "workspace", ids: ["eligible"] }]);
  });

  it("groups sources by workspace and project, orders each group by activity, and searches labels", () => {
    const groups = buildAgentContextSourceGroups({
      agents: [
        agent({
          id: "current",
          projectPlacement: placement({ projectKey: "project-paseo" }),
        }),
        agent({
          id: "workspace-source",
          lastActivityAt: new Date("2026-07-22T10:01:00.000Z"),
        }),
        agent({
          id: "project-older",
          workspaceId: "workspace-b",
          lastActivityAt: new Date("2026-07-22T10:02:00.000Z"),
          projectPlacement: placement({ projectKey: "project-paseo" }),
        }),
        agent({
          id: "project-newer",
          workspaceId: "workspace-c",
          lastActivityAt: new Date("2026-07-22T10:04:00.000Z"),
          projectPlacement: placement({ projectKey: "project-paseo" }),
        }),
        agent({
          id: "documentation",
          workspaceId: "workspace-d",
          lastActivityAt: new Date("2026-07-22T10:03:00.000Z"),
          projectPlacement: placement({
            projectKey: "project-docs",
            projectName: "Documentation",
          }),
        }),
      ],
      serverId: "server-a",
      workspaceId: "workspace-a",
      currentAgentId: "current",
      query: "",
    });

    expect(groupAgentIds(groups)).toEqual([
      { kind: "workspace", ids: ["workspace-source"] },
      { kind: "project", ids: ["project-newer", "project-older"] },
      { kind: "other", ids: ["documentation"] },
    ]);

    const searchGroups = buildAgentContextSourceGroups({
      agents: groups
        .flatMap((group) => group.agents)
        .concat(
          agent({
            id: "current",
            projectPlacement: placement({ projectKey: "project-paseo" }),
          }),
        ),
      serverId: "server-a",
      workspaceId: "workspace-a",
      currentAgentId: "current",
      query: "  documentation  ",
    });

    expect(groupAgentIds(searchGroups)).toEqual([{ kind: "other", ids: ["documentation"] }]);
  });
});

describe("agent context attachment admission", () => {
  it("keeps daemon-local references on their owning host only", () => {
    const attachments: UserComposerAttachment[] = [
      {
        kind: "agent_context",
        source: {
          serverId: "server-a",
          agentId: "source-a",
          title: "Source A",
        },
      },
      {
        kind: "agent_context",
        source: {
          serverId: "server-b",
          agentId: "source-b",
          title: "Source B",
        },
      },
    ];

    expect(hasForeignAgentContextAttachments(attachments, "server-a")).toBe(true);
    expect(filterAgentContextAttachmentsForServer(attachments, "server-a")).toEqual([
      attachments[0],
    ]);
  });

  it("updates a duplicate reference selected through the other interface", () => {
    const picked = appendAgentContextAttachmentFromPicker({
      current: [],
      source: agent({ id: "source", title: "Original title", provider: "claude" }),
    });
    const updated = appendAgentContextAttachmentFromMention({
      current: picked,
      source: {
        serverId: "server-a",
        agentId: "source",
        title: "Updated title",
        provider: "codex",
        workspaceLabel: "Updated workspace",
      },
    });

    expect(updated).toEqual([
      {
        kind: "agent_context",
        source: {
          serverId: "server-a",
          agentId: "source",
          title: "Updated title",
          provider: "codex",
          workspaceLabel: "Updated workspace",
        },
      },
    ]);
  });

  it("disables additional rows once pending selections consume the remaining slots", () => {
    expect(
      isAgentContextSourceSelectionDisabled({
        attached: false,
        selected: false,
        selectionCount: 3,
        remainingSlots: 3,
      }),
    ).toBe(true);
    expect(
      isAgentContextSourceSelectionDisabled({
        attached: false,
        selected: true,
        selectionCount: 3,
        remainingSlots: 3,
      }),
    ).toBe(false);
    expect(
      isAgentContextSourceSelectionDisabled({
        attached: true,
        selected: false,
        selectionCount: 0,
        remainingSlots: 5,
      }),
    ).toBe(true);
  });

  it("admits at most five agent references", () => {
    let attachments: UserComposerAttachment[] = [];
    for (let index = 1; index <= MAX_AGENT_CONTEXT_ATTACHMENTS; index += 1) {
      attachments = appendAgentContextAttachmentFromPicker({
        current: attachments,
        source: agent({ id: `source-${index}` }),
      });
    }

    const afterLimit = appendAgentContextAttachmentFromPicker({
      current: attachments,
      source: agent({ id: "source-6" }),
    });

    expect(
      afterLimit.filter(isAgentContextAttachment).map((entry) => entry.source.agentId),
    ).toEqual(["source-1", "source-2", "source-3", "source-4", "source-5"]);
  });
});
