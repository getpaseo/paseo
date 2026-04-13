import { describe, expect, it } from "vitest";

import {
  buildTmuxCodexPaneSnapshot,
  parseTmuxListPanesOutput,
  parseUnixProcessTable,
  resolveTmuxCodexPaneDescriptors,
} from "./tmux-codex-bridge.js";

describe("tmux codex bridge discovery", () => {
  it("parses tmux pane metadata rows", () => {
    const rows = parseTmuxListPanesOutput(
      [
        "%12\tworkspace-a\t@8\tbash\t1827133\t/dev/pts/2\t/workspace/project",
        "%13\tworkspace-a\t@9\tbash\t1831105\t/dev/pts/7\t/workspace/other",
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        paneId: "%12",
        sessionName: "workspace-a",
        windowId: "@8",
        paneTitle: "bash",
        panePid: 1827133,
        paneTty: "/dev/pts/2",
        cwd: "/workspace/project",
      },
      {
        paneId: "%13",
        sessionName: "workspace-a",
        windowId: "@9",
        paneTitle: "bash",
        panePid: 1831105,
        paneTty: "/dev/pts/7",
        cwd: "/workspace/other",
      },
    ]);
  });

  it("discovers codex panes from tmux and ps output", () => {
    const panes = parseTmuxListPanesOutput(
      [
        "%12\tworkspace-a\t@8\tbash\t1827133\t/dev/pts/2\t/workspace/project",
        "%13\tworkspace-a\t@9\tbash\t1831105\t/dev/pts/7\t/workspace/other",
      ].join("\n"),
    );
    const processes = parseUnixProcessTable(
      [
        "1827133 1827132 node /usr/local/bin/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68",
        "1827143 1827133 /opt/codex/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68",
        "1831105 1831104 node /usr/local/bin/codex resume 019d43f3-7c14-79e2-bffa-16aa4dd81ca3",
        "1831112 1831105 /opt/codex/codex resume 019d43f3-7c14-79e2-bffa-16aa4dd81ca3",
      ].join("\n"),
    );

    const descriptors = resolveTmuxCodexPaneDescriptors({ panes, processes });

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toMatchObject({
      paneId: "%12",
      sessionName: "workspace-a",
      cwd: "/workspace/project",
      codexSessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      processPid: 1827143,
    });
    expect(descriptors[1]).toMatchObject({
      paneId: "%13",
      cwd: "/workspace/other",
      codexSessionId: "019d43f3-7c14-79e2-bffa-16aa4dd81ca3",
      processPid: 1831112,
    });
  });

  it("derives deterministic pane snapshots", () => {
    const snapshot = buildTmuxCodexPaneSnapshot({
      paneId: "%12",
      sessionName: "workspace-a",
      windowId: "@8",
      paneTitle: "Renamed Codex Session",
      panePid: 1827133,
      paneTty: "/dev/pts/2",
      cwd: "/workspace/project",
      processPid: 1827143,
      processArgs: "/opt/codex/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      codexSessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
    });

    expect(snapshot.title).toBe("Renamed Codex Session");
    expect(snapshot.config.title).toBe("Renamed Codex Session");
    expect(snapshot.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(snapshot.persistenceHandle.metadata).toMatchObject({
      externalSessionSource: "tmux_codex",
      paneId: "%12",
      sessionName: "workspace-a",
      windowId: "@8",
      paneTty: "/dev/pts/2",
      processPid: 1827143,
      codexSessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
    });
  });
});
