import { describe, expect, it } from "vitest";
import { vendorEditTransformer } from "./vendor-edit.js";

describe("vendorEditTransformer", () => {
  it("normalizes only the vendor edit payload", () => {
    const transformed = vendorEditTransformer.toolCall?.(
      {
        id: "edit-1",
        name: "vendor_file_edit",
        title: "Edit file",
        status: "completed",
        input: { path: "src/app.ts", before: "old", after: "new" },
        output: null,
        locations: [],
      },
      { sessionId: "session-1" },
    );

    expect(transformed).toMatchObject({
      kind: "edit",
      input: { filePath: "src/app.ts", oldString: "old", newString: "new" },
    });
  });
});
