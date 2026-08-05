import { describe, expect, it } from "vitest";
import { PluginEntrySchema, PluginIdSchema, PluginManifestSchema } from "./types.js";

const manifest = {
  id: "csv-table",
  name: "CSV Table",
  version: "1.0.0",
  contributes: {
    filePreviews: [
      { id: "table", title: "Table", extensions: [".csv", ".tsv"], entry: "preview.html" },
    ],
  },
};

describe("PluginIdSchema", () => {
  it("accepts lowercase dashed ids", () => {
    expect(PluginIdSchema.parse("csv-table")).toBe("csv-table");
  });

  it.each(["../escape", "Csv", "csv_table", "1csv", "csv/table", ""])(
    "rejects %j because it could escape the plugins directory or break the id contract",
    (id) => {
      expect(PluginIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe("PluginEntrySchema", () => {
  it("accepts a flat html filename", () => {
    expect(PluginEntrySchema.parse("preview.html")).toBe("preview.html");
  });

  it.each(["../../etc/passwd", "nested/preview.html", "preview.js", ".html", "preview.HTML"])(
    "rejects %j",
    (entry) => {
      expect(PluginEntrySchema.safeParse(entry).success).toBe(false);
    },
  );
});

describe("PluginManifestSchema", () => {
  it("parses a manifest contributing a file preview", () => {
    expect(PluginManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects an extension that is not dot-prefixed", () => {
    const broken = {
      ...manifest,
      contributes: {
        filePreviews: [{ id: "table", title: "Table", extensions: ["csv"], entry: "preview.html" }],
      },
    };
    expect(PluginManifestSchema.safeParse(broken).success).toBe(false);
  });

  it("parses a manifest with no contributions", () => {
    const empty = { ...manifest, contributes: {} };
    expect(PluginManifestSchema.parse(empty).contributes).toEqual({});
  });
});
