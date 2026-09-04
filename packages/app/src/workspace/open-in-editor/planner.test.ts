import { describe, expect, it } from "vitest";
import type { DesktopOpenExecution } from "@/workspace/desktop-open-targets";
import { planWorkspaceOpenTargets } from "./planner";

const localExecution: DesktopOpenExecution = { kind: "local" };
const remoteExecution: DesktopOpenExecution = {
  kind: "remote",
  destination: { kind: "ssh", host: "dev" },
};
const unconfiguredExecution: DesktopOpenExecution = { kind: "remote-unconfigured" };

const desktopTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
    remoteDestinationKinds: ["ssh"] as const,
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
    remoteDestinationKinds: [],
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
      execution: localExecution,
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
      execution: localExecution,
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
      execution: localExecution,
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

  it("plans a nested directory as the editor workspace", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/specs",
      directoryPath: "repos/sample-android-app",
      desktopTargets: [
        {
          id: "android-studio",
          label: "Android Studio",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
          remoteDestinationKinds: [],
        },
      ],
      canUseDesktopBridge: true,
      execution: localExecution,
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "android-studio",
        label: "Android Studio",
        editorId: "android-studio",
        icon: { kind: "symbol", name: "terminal" },
        openInput: {
          editorId: "android-studio",
          workspacePath: "/specs/repos/sample-android-app",
        },
      },
    ]);
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
          remoteDestinationKinds: [],
        },
      ],
      canUseDesktopBridge: true,
      execution: localExecution,
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
      execution: null,
      checkoutStatus,
    });
    const treeTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [],
      canUseDesktopBridge: false,
      execution: null,
      checkoutStatus,
    });

    expect(blobTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/blob/main/src/app.ts#L3-L5",
      },
    ]);
    expect(treeTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/tree/main",
      },
    ]);
  });

  it("infers the forge from the remote URL when the forge input is null", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      execution: null,
      checkoutStatus: {
        isGit: true,
        remoteUrl: "git@gitlab.com:group/project.git",
        currentBranch: "main",
      },
      forge: null,
    });

    expect(targets).toEqual([
      {
        source: "forge",
        forge: "gitlab",
        id: "gitlab",
        label: "GitLab",
        url: "https://gitlab.com/group/project/-/blob/main/src/app.ts#L3-5",
      },
    ]);
  });

  it("suppresses desktop targets when Electron bridge is unavailable", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: false,
      execution: localExecution,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("suppresses desktop targets when the daemon runs elsewhere and no authority is configured", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      execution: null,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("carries the remote authority into every desktop open input", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 12 },
      desktopTargets,
      canUseDesktopBridge: true,
      execution: remoteExecution,
    });

    expect(targets.map((target) => target.source === "desktop" && target.openInput)).toEqual([
      {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 12,
        remoteDestination: { kind: "ssh", host: "dev" },
      },
      {
        editorId: "finder",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 12,
        remoteDestination: { kind: "ssh", host: "dev" },
      },
    ]);
  });

  it("offers a single setup entry when the daemon is remote and no authority is configured", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3 },
      desktopTargets,
      canUseDesktopBridge: true,
      execution: unconfiguredExecution,
      checkoutStatus,
    });

    expect(targets).toEqual([
      {
        source: "desktop-setup",
        id: "open-in-editor-setup",
        icon: { kind: "symbol", name: "terminal" },
      },
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/blob/main/src/app.ts#L3",
      },
    ]);
  });

  it("offers no setup entry when no remote-capable editor is installed", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: desktopTargets.filter((target) => target.remoteDestinationKinds.length === 0),
      canUseDesktopBridge: true,
      execution: unconfiguredExecution,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("offers no setup entry when the desktop bridge is unavailable", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: false,
      execution: unconfiguredExecution,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("carries the remote authority when opening a folder without an active file", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      execution: remoteExecution,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      openInput: {
        editorId: "vscode",
        workspacePath: "/repo",
        remoteDestination: { kind: "ssh", host: "dev" },
      },
    });
  });
});
