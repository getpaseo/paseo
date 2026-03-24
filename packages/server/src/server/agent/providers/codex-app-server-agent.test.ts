import { describe, expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";

import type { AgentLaunchContext } from "../agent-sdk-types.js";
import {
  __codexAppServerInternals,
  codexAppServerTurnInputFromPrompt,
} from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

describe("Codex app-server provider", () => {
  const logger = createTestLogger();

  test("maps image prompt blocks to Codex localImage input", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
      ],
      logger,
    );
    const localImage = input.find((item) => (item as { type?: string })?.type === "localImage") as
      | { type: "localImage"; path?: string }
      | undefined;
    expect(localImage?.path).toBeTypeOf("string");
    if (localImage?.path) {
      expect(existsSync(localImage.path)).toBe(true);
      rmSync(localImage.path, { force: true });
    }
  });

  test("maps patch notifications with array-style changes and alias diff keys", () => {
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
      callId: "patch-array-alias",
      changes: [
        {
          path: "/tmp/repo/src/array-alias.ts",
          kind: "modify",
          unified_diff: "@@\n-old\n+new\n",
        },
      ],
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/array-alias.ts");
      expect(item.detail.unifiedDiff).toContain("-old");
      expect(item.detail.unifiedDiff).toContain("+new");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("maps patch notifications with object-style single change payloads", () => {
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
      callId: "patch-object-single",
      changes: {
        path: "/tmp/repo/src/object-single.ts",
        kind: "modify",
        patch: "@@\n-before\n+after\n",
      },
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/object-single.ts");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("maps patch notifications with file_path aliases in array-style changes", () => {
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
      callId: "patch-array-file-path",
      changes: [
        {
          file_path: "/tmp/repo/src/alias-path.ts",
          type: "modify",
          diff: "@@\n-before\n+after\n",
        },
      ],
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/alias-path.ts");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("builds app-server env from launch-context env overrides", () => {
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000301",
        PASEO_TEST_FLAG: "codex-launch-value",
      },
    };
    const env = __codexAppServerInternals.buildCodexAppServerEnv(
      {
        env: {
          PASEO_AGENT_ID: "runtime-value",
          PASEO_TEST_FLAG: "runtime-test-value",
        },
      },
      launchContext.env,
    );

    expect(env.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
    expect(env.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
  });
});
