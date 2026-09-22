import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { createPiPaseoExtensionFile } from "./agent.js";

describe("Pi entry capture", () => {
  test("exports user entries from the context path, not the whole session file", async () => {
    const extension = createPiPaseoExtensionFile();
    try {
      const loaded = (await import(pathToFileURL(extension.path).href)) as {
        getCapturedUserEntries: (ctx: unknown) => Array<{ id: string; text: string }>;
      };
      const abandoned = {
        type: "message",
        id: "6f81a132",
        parentId: "old-parent",
        message: { role: "user", content: "可以" },
      };
      const current = {
        type: "message",
        id: "a635f4a1",
        parentId: "recent-parent",
        message: { role: "user", content: "已经完成，开始汇总处理" },
      };
      const captured = loaded.getCapturedUserEntries({
        sessionManager: {
          getEntries: () => [abandoned, current],
          buildContextEntries: () => [current],
        },
      });

      expect(captured).toEqual([
        {
          id: "a635f4a1",
          parentId: "recent-parent",
          text: "已经完成，开始汇总处理",
        },
      ]);
    } finally {
      extension.cleanup();
    }
  });

  test("returns no entry ids when the runtime cannot build the context path", async () => {
    const extension = createPiPaseoExtensionFile();
    try {
      const loaded = (await import(pathToFileURL(extension.path).href)) as {
        getCapturedUserEntries: (ctx: unknown) => unknown[];
      };

      expect(
        loaded.getCapturedUserEntries({
          sessionManager: {
            getEntries: () => [
              {
                type: "message",
                id: "old",
                parentId: null,
                message: { role: "user", content: "可以" },
              },
            ],
          },
        }),
      ).toEqual([]);
    } finally {
      extension.cleanup();
    }
  });
});
