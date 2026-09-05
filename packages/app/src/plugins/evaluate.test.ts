import { describe, expect, it } from "vitest";
import { evaluatePluginClientBundle } from "./evaluate";

function bundle(body: string): string {
  return `(function() {
    const module = { exports: {} };
    module.exports.default = function(plugin) { ${body}; return function() {}; };
    return module.exports;
  })`;
}

describe("evaluatePluginClientBundle", () => {
  it("keeps indirect eval out of the contribution lexical context", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "indirect-eval",
        bundle(`
          const run = eval;
          run("plugin.addTool({})");
        `),
      ),
    ).toThrow(/plugin is not defined|cannot read properties of undefined/i);
  });

  it("ignores server registrations that survive client bundle filtering", () => {
    const plugin = evaluatePluginClientBundle(
      "wrong-target",
      bundle(`
        const register = (context, method, value) => context[method](value);
        const serverTool = { name: "wrong-target.tool" };
        const serverContract = { name: "wrong-target.rpc" };
        const serverHandler = () => "not invoked";
        function registerServerContributions(context) {
          register(context, "addTool", serverTool);
          const handle = context.handle;
          handle(serverContract, serverHandler);
        }
        registerServerContributions(plugin);
      `),
    );

    expect(plugin.surfaces).toEqual([]);
    expect(plugin.sidebarItems).toEqual([]);
    expect(plugin.attachmentSources).toEqual([]);
    expect(plugin.themes).toEqual([]);
    expect(plugin.timelineTransformers).toEqual([]);
    expect(plugin.timelineRenderers).toEqual([]);
  });

  it("collects timeline transformers and renderers", () => {
    const plugin = evaluatePluginClientBundle(
      "reports",
      bundle(`
        function Card() { return null; }
        const schema = { safeParse(value) { return { success: true, data: value }; } };
        plugin.addTimelineTransformer({
          id: "test-report",
          query: { itemType: "tool_call" },
          transform() { return { items: [] }; },
        });
        plugin.addTimelineRenderer({
          kind: "test-report",
          version: 1,
          schema,
          Component: Card,
        });
      `),
    );

    expect(plugin.timelineTransformers.map(({ id, query }) => ({ id, query }))).toEqual([
      { id: "test-report", query: { itemType: "tool_call" } },
    ]);
    expect(plugin.timelineRenderers.map(({ kind, version }) => ({ kind, version }))).toEqual([
      { kind: "test-report", version: 1 },
    ]);
  });

  it("rejects unknown timeline item types", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "reports",
        bundle(`
          plugin.addTimelineTransformer({
            id: "bad-query",
            query: { itemType: "settled" },
            transform() { return { items: [] }; },
          });
        `),
      ),
    ).toThrow("Timeline transformer bad-query has invalid item type: settled");
  });

  it("collects a surface and its sidebar placement", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      bundle(`
        function Surface() { return null; }
        plugin.addSurface("main", Surface);
        plugin.addSidebarItem({ id: "main", title: "Example", icon: "Blocks", surface: "main" });
      `),
    );

    expect(plugin.id).toBe("example");
    expect(plugin.surfaces.map((surface) => surface.id)).toEqual(["main"]);
    expect(plugin.sidebarItems).toEqual([
      { id: "main", title: "Example", icon: "Blocks", surface: "main" },
    ]);
  });

  it("collects a declarative attachment source", () => {
    const plugin = evaluatePluginClientBundle(
      "linear",
      bundle(`
        plugin.addAttachmentSource({
          id: "issues",
          title: "Linear issue",
          icon: "CircleDot",
          pickerTitle: "Attach Linear issue",
          searchPlaceholder: "Search by identifier or title",
          search: { name: "issues.search", input: {}, output: {} },
        });
      `),
    );

    expect(plugin.attachmentSources).toEqual([
      {
        id: "issues",
        title: "Linear issue",
        icon: "CircleDot",
        pickerTitle: "Attach Linear issue",
        searchPlaceholder: "Search by identifier or title",
        search: { name: "issues.search", input: {}, output: {} },
      },
    ]);
  });

  it("collects contextual workspace panels and Command Center items", () => {
    const plugin = evaluatePluginClientBundle(
      "review",
      bundle(`
        function ReviewPanel() { return null; }
        plugin.addWorkspacePanel({
          id: "review",
          title: "Review",
          icon: "Scan",
          context: "agent",
          Component: ReviewPanel,
        });
        plugin.addCommandCenterItem({
          id: "open-review",
          title: "Open review",
          icon: "Scan",
          context: "agent",
          onSelect() {},
        });
      `),
    );

    expect(
      plugin.workspacePanels.map(({ id, title, icon, context, locations }) => ({
        id,
        title,
        icon,
        context,
        locations,
      })),
    ).toEqual([
      {
        id: "review",
        title: "Review",
        icon: "Scan",
        context: "agent",
        locations: ["workspace"],
      },
    ]);
    expect(
      plugin.commandCenterItems.map(({ id, title, icon, context }) => ({
        id,
        title,
        icon,
        context,
      })),
    ).toEqual([{ id: "open-review", title: "Open review", icon: "Scan", context: "agent" }]);
  });

  it("normalizes and validates workspace panel locations", () => {
    const plugin = evaluatePluginClientBundle(
      "review",
      bundle(`
        function ReviewPanel() { return null; }
        plugin.addWorkspacePanel({
          id: "review",
          title: "Review",
          icon: "Scan",
          context: "agent",
          locations: ["workspace", "explorer"],
          Component: ReviewPanel,
        });
      `),
    );
    expect(plugin.workspacePanels[0]?.locations).toEqual(["workspace", "explorer"]);

    for (const [locations, message] of [
      ["[]", "must support at least one location"],
      ['["sidebar"]', "has invalid location: sidebar"],
      ['["explorer", "explorer"]', "has duplicate locations"],
    ] as const) {
      expect(() =>
        evaluatePluginClientBundle(
          "review",
          bundle(`
            function ReviewPanel() { return null; }
            plugin.addWorkspacePanel({
              id: "review",
              title: "Review",
              icon: "Scan",
              context: "agent",
              locations: ${locations},
              Component: ReviewPanel,
            });
          `),
        ),
      ).toThrow(message);
    }
  });

  it("rejects duplicate workspace panel and Command Center ids", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "review",
        bundle(`
          function Panel() { return null; }
          const panel = { id: "review", title: "Review", icon: "Scan", context: "workspace", Component: Panel };
          plugin.addWorkspacePanel(panel);
          plugin.addWorkspacePanel(panel);
        `),
      ),
    ).toThrow("Duplicate workspace panel: review");

    expect(() =>
      evaluatePluginClientBundle(
        "review",
        bundle(`
          const item = { id: "review", title: "Review", icon: "Scan", context: "global", onSelect() {} };
          plugin.addCommandCenterItem(item);
          plugin.addCommandCenterItem(item);
        `),
      ),
    ).toThrow("Duplicate Command Center item: review");
  });

  it("collects one explicit client-side entrypoint", () => {
    const plugin = evaluatePluginClientBundle(
      "review",
      bundle(`
        function contributeClient() { return function() {}; }
        plugin.addClientSide(contributeClient);
      `),
    );
    expect(plugin.clientSide).toBeTypeOf("function");

    expect(() =>
      evaluatePluginClientBundle(
        "review",
        bundle(`
          function contributeClient() { return function() {}; }
          plugin.addClientSide(contributeClient);
          plugin.addClientSide(contributeClient);
        `),
      ),
    ).toThrow("Plugin has more than one client-side entrypoint");
  });

  it("rejects duplicate attachment source ids", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "linear",
        bundle(`
          const source = {
            id: "issues",
            title: "Linear issue",
            icon: "CircleDot",
            pickerTitle: "Attach Linear issue",
            searchPlaceholder: "Search",
            search: { name: "issues.search", input: {}, output: {} },
          };
          plugin.addAttachmentSource(source);
          plugin.addAttachmentSource(source);
        `),
      ),
    ).toThrow("Duplicate attachment source: issues");
  });

  it("collects a contributed theme", () => {
    const plugin = evaluatePluginClientBundle(
      "catppuccin",
      bundle(`
        plugin.addTheme({
          id: "mocha",
          name: "Catppuccin Mocha",
          appearance: "dark",
          colors: {
            background: "#1e1e2e",
            foreground: "#cdd6f4",
            raised: "#313244",
            control: "#45475a",
            border: "#45475a",
            accent: "#cba6f7",
            mutedForeground: "#a6adc8",
            ring: "#6c7086",
          },
        });
      `),
    );

    expect(plugin.themes.map((theme) => [theme.id, theme.name])).toEqual([
      ["mocha", "Catppuccin Mocha"],
    ]);
    expect(plugin.themes[0]?.colors.accent).toBe("#cba6f7");
  });

  it("rejects a theme with a color that is not a hex value", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "catppuccin",
        bundle(`
          plugin.addTheme({
            id: "mocha",
            name: "Catppuccin Mocha",
            appearance: "dark",
            colors: {
              background: "rebeccapurple",
              foreground: "#cdd6f4",
              raised: "#313244",
              control: "#45475a",
              border: "#45475a",
              mutedForeground: "#a6adc8",
              ring: "#6c7086",
            },
          });
        `),
      ),
    ).toThrow("Must be a hex color");
  });

  it("rejects duplicate theme ids", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "catppuccin",
        bundle(`
          const theme = {
            id: "mocha",
            name: "Catppuccin Mocha",
            appearance: "dark",
            colors: {
              background: "#1e1e2e",
              foreground: "#cdd6f4",
              raised: "#313244",
              control: "#45475a",
              border: "#45475a",
              mutedForeground: "#a6adc8",
              ring: "#6c7086",
            },
          };
          plugin.addTheme(theme);
          plugin.addTheme(theme);
        `),
      ),
    ).toThrow("Duplicate theme: mocha");
  });

  it("rejects a sidebar placement whose surface does not exist", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        bundle(`
          plugin.addSidebarItem({ id: "main", title: "Example", icon: "Blocks", surface: "missing" });
        `),
      ),
    ).toThrow("references missing surface missing");
  });

  it("rejects a bundle without a default contribution function", () => {
    expect(() => evaluatePluginClientBundle("example", `(function() { return {}; })`)).toThrow(
      "must default export a function",
    );
  });

  it("requires a cleanup function", () => {
    expect(() =>
      evaluatePluginClientBundle("example", `(function() { return { default: function() {} }; })`),
    ).toThrow("must return a cleanup function");
  });

  it("provides the host Icon component through @getpaseo/plugin", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { Icon } = require("@getpaseo/plugin");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          plugin.addSurface("main", function Surface() {
            return Icon({ name: "Settings", size: 18, color: "#123456" });
          });
          return function() {};
        };
        return module.exports;
      })`,
    );

    const Component = plugin.surfaces[0]?.Component;
    expect(Component).toBeTypeOf("function");
    const element = (Component as (props: never) => { props: unknown })({} as never);
    expect(element).toMatchObject({ props: { size: 18, color: "#123456" } });
  });

  it("provides the host client runtime through the legacy @paseo/plugin alias", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { defineRpc } = require("@paseo/plugin");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          const contract = defineRpc({ name: "legacy", input: {}, output: {} });
          plugin.addAttachmentSource({
            id: "legacy",
            title: "Legacy",
            icon: "Settings",
            pickerTitle: "Legacy",
            searchPlaceholder: "Search",
            search: contract,
          });
          return function() {};
        };
        return module.exports;
      })`,
    );

    expect(plugin.attachmentSources[0]?.search.name).toBe("legacy");
  });

  it("provides Paseo UI through @getpaseo/plugin/react-native", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { Icon, Modal, useToast } = require("@getpaseo/plugin/react-native");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          if (typeof Icon !== "function" || typeof Modal !== "function" || typeof Modal.Content !== "function" || typeof useToast !== "function") {
            throw new Error("React Native plugin UI is incomplete");
          }
          plugin.addSurface("main", function Surface() { return null; });
          return function() {};
        };
        return module.exports;
      })`,
    );

    expect(plugin.surfaces.map((surface) => surface.id)).toEqual(["main"]);
  });

  it.each(["@getpaseo/plugin/server", "@paseo/plugin/server"])(
    "resolves %s for shared RPC contracts",
    (specifier) => {
      const plugin = evaluatePluginClientBundle(
        "example",
        `(function(require) {
        const { defineRpc, defineAttachmentSource, defineTool } = require(${JSON.stringify(specifier)});
        const search = defineRpc({ name: "issues.search", input: {}, output: {} });
        const tool = defineTool({ name: "issues.lookup" });
        if (tool.name !== "issues.lookup") throw new Error("defineTool is not an identity helper");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          plugin.addTool(tool);
          plugin.addAttachmentSource(defineAttachmentSource({
            id: "issues",
            title: "Issue",
            icon: "CircleDot",
            pickerTitle: "Attach issue",
            searchPlaceholder: "Search",
            search,
          }));
          return function() {};
        };
        return module.exports;
      })`,
      );

      expect(plugin.attachmentSources.map((source) => source.search.name)).toEqual([
        "issues.search",
      ]);
    },
  );

  it("rejects modules that are not part of the client runtime", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        `(function(require) {
          require("fs");
          const module = { exports: {} };
          module.exports.default = function() { return function() {}; };
          return module.exports;
        })`,
      ),
    ).toThrow('Module "fs" is not available in plugin client code');
  });

  it("does not publish partial contributions when setup fails", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        `(function() { return { default: function(plugin) {
          plugin.addSurface("main", function() { return null; });
          throw new Error("setup exploded");
        } }; })`,
      ),
    ).toThrow("setup exploded");
  });
});
