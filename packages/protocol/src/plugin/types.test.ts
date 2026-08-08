import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PluginEntrySchema,
  PluginIdSchema,
  PluginManifestSchema,
  PluginRegistryIndexEnvelopeSchema,
} from "./types.js";

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

describe("PluginRegistryIndexEnvelopeSchema", () => {
  it("accepts an index version this daemon predates", () => {
    expect(PluginRegistryIndexEnvelopeSchema.parse({ version: 2, plugins: [] }).version).toBe(2);
  });

  it("accepts entries it cannot validate, so the client can drop them one by one", () => {
    const parsed = PluginRegistryIndexEnvelopeSchema.parse({
      version: 1,
      plugins: [{ nonsense: true }],
    });
    expect(parsed.plugins).toEqual([{ nonsense: true }]);
  });

  it("rejects an envelope that is not an index at all", () => {
    expect(PluginRegistryIndexEnvelopeSchema.safeParse({ version: 1, plugins: {} }).success).toBe(
      false,
    );
  });
});

/**
 * `examples/` is outside the npm workspaces, so it has no test runner of its
 * own. The example plugin is documented as a working starting point, so its
 * manifest is validated here against the schema that has to accept it.
 */
describe("examples/plugins/hello-paseo", () => {
  const exampleManifestUrl = new URL(
    "../../../../examples/plugins/hello-paseo/paseo-plugin.json",
    import.meta.url,
  );

  it("ships a manifest that parses and contributes both kinds", () => {
    const parsed = PluginManifestSchema.parse(
      JSON.parse(readFileSync(exampleManifestUrl, "utf8")) as unknown,
    );
    expect(parsed.id).toBe("hello-paseo");
    expect(parsed.contributes.filePreviews?.map((preview) => preview.entry)).toEqual([
      "preview.html",
    ]);
    expect(parsed.contributes.sidebarPanels?.map((panel) => panel.entry)).toEqual(["pet.html"]);
  });

  it("ships every entry file the manifest names", () => {
    const parsed = PluginManifestSchema.parse(
      JSON.parse(readFileSync(exampleManifestUrl, "utf8")) as unknown,
    );
    const entries = [
      ...(parsed.contributes.filePreviews ?? []),
      ...(parsed.contributes.sidebarPanels ?? []),
    ].map((contribution) => contribution.entry);

    for (const entry of entries) {
      expect(() => readFileSync(new URL(entry, exampleManifestUrl), "utf8")).not.toThrow();
    }
  });
});
