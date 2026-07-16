import { describe, expect, it } from "vitest";
import { planWorkspaceOpenTargets } from "./open-target-planner";

const desktopTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
];

const checkoutStatus = {
  isGit: true,
  remoteUrl: "git@github.com:getpaseo/paseo.git",
  currentBranch: "main",
};

describe("planWorkspaceOpenTargets", () => {
  it("plans editor targets with active-file absolute path and cwd", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 3,
      },
    });
  });

  it("plans file-manager targets with active-file absolute path and reveal mode", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: {
        editorId: "finder",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
      },
    });
  });

  it("plans no active file as opening the workspace folder", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: { editorId: "vscode", workspacePath: "/repo" },
    });
    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: { editorId: "finder", workspacePath: "/repo" },
    });
  });

  it("passes custom target ids through as strings", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets: [
        {
          id: "script:open-in-nvim",
          label: "Open in Neovim",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "script:open-in-nvim",
        label: "Open in Neovim",
        editorId: "script:open-in-nvim",
        icon: { kind: "symbol", name: "terminal" },
        openInput: {
          editorId: "script:open-in-nvim",
          workspacePath: "/repo",
          filePath: "/repo/src/app.ts",
        },
      },
    ]);
  });

  it("keeps GitHub target independent and uses blob and tree URLs", () => {
    const blobTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });
    const treeTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(blobTargets).toEqual([
      {
        source: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/blob/main/src/app.ts#L3-L5",
      },
    ]);
    expect(treeTargets).toEqual([
      {
        source: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/tree/main",
      },
    ]);
  });

  it("suppresses desktop targets when Electron bridge is unavailable", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: false,
      isLocalExecution: true,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("suppresses desktop targets for remote execution paths", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });
});
