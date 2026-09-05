import { describe, expect, it } from "vitest";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";

const runtime = {
  paseo: {},
  async rpc() {},
  openSurface() {},
  openPanel() {},
  addComposerPill() {
    return () => undefined;
  },
} as unknown as PluginClientRuntime;

function evaluatePluginClientBundle(id: string, source: string) {
  return runPluginClientBundle(id, source, runtime);
}

function bundle(body: string): string {
  return `(function() {
    const module = { exports: {} };
    module.exports.default = function(plugin) { ${body}; return function() {}; };
    return module.exports;
  })`;
}

describe("evaluatePluginClientBundle", () => {
  it("returns idempotent removers for every client registration", () => {
    let pillCount = 0;
    const plugin = runPluginClientBundle(
      "removals",
      bundle(`
        function Component() { return null; }
        const schema = { safeParse(value) { return { success: true, data: value }; } };
        globalThis.__pluginRemovals = [
          plugin.addSurface("main", Component),
          plugin.addSidebarItem({ id: "main", title: "Main", icon: "Blocks", surface: "main" }),
          plugin.addWorkspacePanel({ id: "panel", title: "Panel", icon: "Blocks", context: "workspace", Component }),
          plugin.addCommandCenterItem({ id: "command", title: "Command", icon: "Blocks", context: "global", onSelect() {} }),
          plugin.addSlashCommand({ name: "review", description: "Review", argumentHint: "", context: "workspace", onSubmit() {} }),
          plugin.addComposerPill({ id: "pill", title: "Pill", workspaceId: "workspace", agentId: "agent", Component, onPress() {} }),
          plugin.addAttachmentSource({ id: "issues", title: "Issues", icon: "Blocks", pickerTitle: "Attach issue", searchPlaceholder: "Search", search: { name: "issues.search", input: {}, output: {} } }),
          plugin.addTheme({ id: "night", name: "Night", appearance: "dark", colors: { background: "#000", foreground: "#fff", raised: "#111", control: "#222", border: "#333", mutedForeground: "#aaa", ring: "#555" } }),
          plugin.addTimelineTransformer({ id: "transformer", query: { itemType: "tool_call" }, transform() { return { items: [] }; } }),
          plugin.addTimelineRenderer({ kind: "card", version: 1, schema, Component }),
        ];
      `),
      {
        ...runtime,
        addComposerPill() {
          pillCount += 1;
          return () => {
            pillCount -= 1;
          };
        },
      },
    );
    const removals = Reflect.get(globalThis, "__pluginRemovals") as Array<() => void>;

    expect(
      [
        plugin.surfaces,
        plugin.sidebarItems,
        plugin.workspacePanels,
        plugin.commandCenterItems,
        plugin.clientSlashCommands,
        plugin.attachmentSources,
        plugin.themes,
        plugin.timelineTransformers,
        plugin.timelineRenderers,
      ].every((items) => items.length === 1),
    ).toBe(true);
    expect(pillCount).toBe(1);
    for (const remove of removals) {
      remove();
      remove();
    }
    expect(
      [
        plugin.surfaces,
        plugin.sidebarItems,
        plugin.workspacePanels,
        plugin.commandCenterItems,
        plugin.clientSlashCommands,
        plugin.attachmentSources,
        plugin.themes,
        plugin.timelineTransformers,
        plugin.timelineRenderers,
      ].every((items) => items.length === 0),
    ).toBe(true);
    expect(pillCount).toBe(0);
    Reflect.deleteProperty(globalThis, "__pluginRemovals");
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

  it("runs the client entry with the full runtime context", () => {
    const plugin = evaluatePluginClientBundle(
      "review",
      bundle(`
        if (!plugin.paseo || !plugin.rpc || !plugin.openSurface || !plugin.openPanel || !plugin.addComposerPill) {
          throw new Error("missing client runtime");
        }
      `),
    );
    expect(plugin.id).toBe("review");
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

  it("resolves shared RPC helpers from @getpaseo/plugin", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { defineRpc, defineAttachmentSource } = require("@getpaseo/plugin");
        const search = defineRpc({ name: "issues.search", input: {}, output: {} });
        const module = { exports: {} };
        module.exports.default = function(plugin) {
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

    expect(plugin.attachmentSources.map((source) => source.search.name)).toEqual(["issues.search"]);
  });

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
