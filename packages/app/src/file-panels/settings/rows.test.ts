import { describe, expect, it } from "vitest";
import { filePanelCatalog, sourceFilePanel } from "../catalog";
import type { FilePanelCandidate } from "../resolve";
import { buildFilePanelSettingsRows } from "./rows";

type HostedCandidate = FilePanelCandidate & { serverId?: string };

const builtinMarkdown: HostedCandidate = filePanelCatalog([])[0];
const builtinImage: HostedCandidate = filePanelCatalog([])[2];
const source: HostedCandidate = sourceFilePanel;

/** What Settings reads: the built-ins and every host's plugin panels, in catalog order. */
function catalog(...plugins: HostedCandidate[]): HostedCandidate[] {
  return [...filePanelCatalog(plugins)];
}

function richMarkdown(serverId: string): HostedCandidate {
  return {
    id: "plugin:markdown-panel/rich-markdown",
    builtin: false,
    files: { extensions: ["MD"] },
    serverId,
  };
}

const dockerfile: HostedCandidate = {
  id: "plugin:docker/dockerfile",
  builtin: false,
  files: { extensions: [], filenames: ["Dockerfile"] },
  serverId: "host-a",
};

function rows(candidates: HostedCandidate[], associations: Record<string, string> = {}) {
  return buildFilePanelSettingsRows({ candidates, associations });
}

describe("buildFilePanelSettingsRows", () => {
  it("has nothing to configure when only built-in panels claim a key", () => {
    expect(rows(catalog())).toEqual([]);
  });

  it("lists a key a plugin panel claims with the built-in first and no Source", () => {
    const plugin = richMarkdown("host-a");
    expect(rows(catalog(plugin))).toEqual([
      {
        selectorKey: "ext:md",
        candidates: [builtinMarkdown, plugin],
        associatedPanelId: null,
      },
    ]);
  });

  it("offers Source on a key only a plugin panel claims, as the picker does for a text file", () => {
    const toml: HostedCandidate = {
      id: "plugin:toml/toml",
      builtin: false,
      files: { extensions: ["toml"] },
    };
    expect(rows(catalog(toml))).toEqual([
      { selectorKey: "ext:toml", candidates: [toml, source], associatedPanelId: null },
    ]);
    const other: HostedCandidate = { ...dockerfile, id: "plugin:other/dockerfile" };
    expect(rows(catalog(dockerfile, other))[0]?.candidates).toEqual([dockerfile, other, source]);
  });

  it("does not offer Source on a key the built-in image panel claims", () => {
    const viewer: HostedCandidate = {
      id: "plugin:viewer/png",
      builtin: false,
      files: { extensions: ["png"] },
    };
    expect(rows(catalog(viewer))).toEqual([
      { selectorKey: "ext:png", candidates: [builtinImage, viewer], associatedPanelId: null },
    ]);
  });

  it("offers a panel installed on several hosts once, as the first host has it", () => {
    const first = richMarkdown("host-a");
    const [row] = rows(catalog(first, richMarkdown("host-b")));
    expect(row?.candidates).toEqual([builtinMarkdown, first]);
  });

  it("keeps a remembered key that only built-in panels claim", () => {
    expect(rows(catalog(), { "ext:markdown": source.id })).toEqual([
      {
        selectorKey: "ext:markdown",
        candidates: [builtinMarkdown],
        associatedPanelId: source.id,
      },
    ]);
  });

  it("offers only Source on a text key no other panel claims", () => {
    expect(rows(catalog(), { "ext:ts": source.id })).toEqual([
      { selectorKey: "ext:ts", candidates: [source], associatedPanelId: source.id },
    ]);
  });

  it("keeps a remembered key whose panel is on no connected host", () => {
    expect(rows(catalog(), { "ext:pdf": "plugin:pdf-panel/pdf" })).toEqual([
      { selectorKey: "ext:pdf", candidates: [source], associatedPanelId: "plugin:pdf-panel/pdf" },
    ]);
  });

  it("offers extension panels on a filename key the way the resolver does", () => {
    const named: HostedCandidate = {
      ...dockerfile,
      id: "plugin:readme/readme",
      files: { extensions: [], filenames: ["README.md"] },
    };
    const keys = rows(catalog(named)).map((row) => row.selectorKey);
    expect(keys).toEqual(["name:README.md"]);
    expect(rows(catalog(named))[0]?.candidates).toEqual([builtinMarkdown, named]);
  });

  it("orders extensions before filenames, each alphabetically", () => {
    const other: HostedCandidate = { ...dockerfile, id: "plugin:other/dockerfile" };
    const html: HostedCandidate = {
      ...richMarkdown("host-a"),
      id: "plugin:web/html",
      files: { extensions: ["html"] },
    };
    const keys = rows(catalog(dockerfile, other, html, richMarkdown("host-a"))).map(
      (row) => row.selectorKey,
    );
    expect(keys).toEqual(["ext:html", "ext:md", "name:Dockerfile"]);
  });
});
