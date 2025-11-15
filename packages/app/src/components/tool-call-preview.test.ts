import { describe, expect, it } from "vitest";

import { resolveToolCallPreview } from "./tool-call-preview";
import type { CommandDetails, EditEntry, ReadEntry } from "@/utils/tool-call-parsers";

describe("resolveToolCallPreview", () => {
  it("prefers parsed hydration payloads when provided", () => {
    const parsedEdits: EditEntry[] = [
      {
        filePath: "README.md",
        diffLines: [
          { type: "header", content: "@@ -1 +1 @@" },
          { type: "remove", content: "-Old" },
          { type: "add", content: "+New" },
        ],
      },
    ];
    const parsedReads: ReadEntry[] = [
      {
        filePath: "README.md",
        content: "# Hydrated\nFinal text\n",
      },
    ];
    const parsedCommand: CommandDetails = {
      command: "ls",
      cwd: "/tmp/hydrated",
      output: "README.md\npackages\n",
      exitCode: 0,
    };

    const preview = resolveToolCallPreview({
      parsedEditEntries: parsedEdits,
      parsedReadEntries: parsedReads,
      parsedCommandDetails: parsedCommand,
    });

    expect(preview.editEntries).toBe(parsedEdits);
    expect(preview.readEntries).toBe(parsedReads);
    expect(preview.commandDetails).toBe(parsedCommand);
  });

  it("falls back to derived parser output when hydration metadata is missing", () => {
    const args = {
      type: "mcp_tool_use",
      id: "call_fallback",
      name: "apply_patch",
      server: "editor",
      input: {
        file_path: "README.md",
        patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-Old\n+New\n*** End Patch",
      },
    };
    const result = {
      changes: [
        {
          file_path: "README.md",
          previous_content: "Old\n",
          content: "New\n",
        },
      ],
    };

    const preview = resolveToolCallPreview({
      args,
      result,
    });

    expect(preview.editEntries[0]?.diffLines.length).toBeGreaterThan(0);
    expect(
      preview.editEntries[0]?.diffLines.some((line) => line.content.includes("+New"))
    ).toBe(true);
    expect(preview.commandDetails).toBeNull();
  });
});
