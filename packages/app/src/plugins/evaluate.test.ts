import { describe, expect, it, vi } from "vitest";
import type { PluginFloatingWidgetRegistration } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "./types";
import { groupFloatingWidgets, selectFloatingWidgetTarget } from "./floating-widgets/model";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";

const runtime = {
  paseo: {},
  async rpc() {},
  openSettings() {},
  openScreen() {},
  openSurface() {},
  openPanel() {},
  addHeaderButton() {
    return { update() {}, remove() {} };
  },
  addComposerPill() {
    return { update() {}, remove() {} };
  },
} as unknown as PluginClientRuntime;

function evaluatePluginClientBundle(id: string, source: string) {
  return runPluginClientBundle(id, source, runtime);
}

function bundle(body: string): string {
  return `(function(require) {
    const module = { exports: {} };
    module.exports.default = function(plugin) { ${body}; return function() {}; };
    return module.exports;
  })`;
}

describe("provider icon overrides", () => {
  it("registers sanitized icons and releases them with the plugin lifetime", async () => {
    const plugin = evaluatePluginClientBundle(
      "appearance",
      bundle(`
        const remove = plugin.addProviderIconOverride({ id: "brand", provider: "custom-provider", icon: "Star" });
        remove();
        remove();
        plugin.addProviderIconOverride({ id: "brand", provider: " codex ", icon: { svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>' } });
      `),
    );
    expect(plugin.providerIconOverrides).toEqual([
      {
        id: "brand",
        provider: "codex",
        icon: { svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>' },
      },
    ]);
    await plugin.cleanup();
    expect(plugin.providerIconOverrides).toEqual([]);
  });

  it.each([
    ['id: "Bad"', "provider icon override id"],
    ['provider: " "', "no provider"],
    ['icon: "NotAnIcon"', "unknown Lucide"],
    ['icon: { svg: "<svg><script /></svg>" }', "script elements"],
    ["icon: () => null", "expected a Lucide"],
  ])("rejects invalid provider icon overrides: %s", (override, message) => {
    expect(() =>
      evaluatePluginClientBundle(
        "appearance",
        bundle(`
      plugin.addProviderIconOverride({ id: "brand", provider: "codex", icon: "Star", ${override} });
    `),
      ),
    ).toThrow(message);
  });

  it("rejects duplicate registrations and releases registrations after failed setup", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "appearance",
        bundle(`
      const input = { id: "brand", provider: "codex", icon: "Star" };
      plugin.addProviderIconOverride(input);
      plugin.addProviderIconOverride(input);
    `),
      ),
    ).toThrow("Duplicate provider icon override");
    expect(() =>
      evaluatePluginClientBundle(
        "appearance",
        bundle(`
      globalThis.__failedIconPlugin = plugin;
      plugin.addProviderIconOverride({ id: "brand", provider: "codex", icon: "Star" });
      throw new Error("setup failed");
    `),
      ),
    ).toThrow("setup failed");
    const context = Reflect.get(
      globalThis,
      "__failedIconPlugin",
    ) as import("@getpaseo/plugin/client").PluginClientContext;
    expect(() =>
      context.addProviderIconOverride({ id: "later", provider: "codex", icon: "Star" }),
    ).toThrow("Plugin has stopped");
    Reflect.deleteProperty(globalThis, "__failedIconPlugin");
  });
});

describe("workspace status renderers", () => {
  it("keeps a memoized renderer for its registration lifetime and rejects use after stop", async () => {
    const plugin = evaluatePluginClientBundle(
      "status",
      bundle(`
      globalThis.__statusPluginContext = plugin;
      const Component = require("react").memo(() => null);
      const remove = plugin.addWorkspaceStatusRenderer({ id: "orbit", Component });
      remove();
      remove();
      plugin.addWorkspaceStatusRenderer({ id: "orbit", Component });
    `),
    );
    expect(plugin.workspaceStatusRenderers).toHaveLength(1);
    expect(plugin.workspaceStatusRenderers[0]?.id).toBe("orbit");
    await plugin.cleanup();
    expect(plugin.workspaceStatusRenderers).toEqual([]);
    const context = Reflect.get(
      globalThis,
      "__statusPluginContext",
    ) as import("@getpaseo/plugin/client").PluginClientContext;
    expect(() =>
      context.addWorkspaceStatusRenderer({ id: "later", Component: () => null }),
    ).toThrow("Plugin has stopped");
    Reflect.deleteProperty(globalThis, "__statusPluginContext");
  });

  it.each([
    ['id: "Bad"', "workspace status renderer id"],
    ['Component: "div"', "not a component"],
    ["Component: {}", "not a component"],
  ])("rejects invalid status renderers: %s", (override, message) => {
    expect(() =>
      evaluatePluginClientBundle(
        "status",
        bundle(`
      plugin.addWorkspaceStatusRenderer({ id: "orbit", Component() { return null; }, ${override} });
    `),
      ),
    ).toThrow(message);
  });

  it("rejects duplicate renderer IDs", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "status",
        bundle(`
      const input = { id: "orbit", Component() { return null; } };
      plugin.addWorkspaceStatusRenderer(input);
      plugin.addWorkspaceStatusRenderer(input);
    `),
      ),
    ).toThrow("Duplicate workspace status renderer");
  });
});

describe("evaluatePluginClientBundle", () => {
  it("updates, hides, restores and removes a floating widget without reviving it after teardown", async () => {
    const changed = vi.fn();
    const plugin = runPluginClientBundle(
      "pets",
      bundle(`
      globalThis.__floatingRegistration = plugin.addFloatingWidget({
        id: "pet", title: "Pet", Component() { return null; }, initiallyVisible: false,
      });
    `),
      runtime,
      changed,
    );
    const registration = Reflect.get(
      globalThis,
      "__floatingRegistration",
    ) as PluginFloatingWidgetRegistration;
    const widget = plugin.floatingWidgets[0]!;
    expect(widget.visible).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    registration.show();
    expect(widget.visible).toBe(true);
    const firstReveal = widget.revealRevision;
    expect(firstReveal).toBeGreaterThan(0);
    registration.update({ title: "Activity widget", size: { width: 192, height: 240 } });
    expect(widget.contribution.title).toBe("Activity widget");
    expect(widget.contribution.size).toEqual({ width: 192, height: 240 });
    expect(() =>
      registration.update({ title: "Broken", size: { width: NaN, height: 20 } }),
    ).toThrow("size");
    expect(widget.contribution.title).toBe("Activity widget");
    registration.hide();
    expect(widget.visible).toBe(false);
    registration.show();
    expect(widget.revealRevision).toBeGreaterThan(firstReveal);
    await plugin.cleanup();
    expect(plugin.floatingWidgets).toEqual([]);
    changed.mockClear();
    registration.show();
    registration.hide();
    registration.update({ title: "Gone" });
    registration.remove();
    expect(changed).not.toHaveBeenCalled();
    expect(widget.contribution.title).toBe("Activity widget");
    Reflect.deleteProperty(globalThis, "__floatingRegistration");
  });

  it("honors show across host installations and keeps hide scoped to its own installation", async () => {
    const make = (serverId: string) => {
      const evaluated = evaluatePluginClientBundle(
        "pet",
        bundle(`
        globalThis.__floating_${serverId} = plugin.addFloatingWidget({
          id: "pet", title: "Pet", Component() { return null; },
        });
      `),
      );
      return { ...evaluated, serverId } as InstalledPlugin;
    };
    const a = make("a");
    const b = make("b");
    const showA = Reflect.get(globalThis, "__floating_a") as PluginFloatingWidgetRegistration;
    const showB = Reflect.get(globalThis, "__floating_b") as PluginFloatingWidgetRegistration;
    const group = groupFloatingWidgets([a, b])[0]!;
    showA.show();
    expect(selectFloatingWidgetTarget(group, null).plugin).toBe(a);
    showA.hide();
    showB.show();
    expect(selectFloatingWidgetTarget(group, "a").plugin).toBe(b);
    expect(selectFloatingWidgetTarget(group, "a").widget.visible).toBe(true);
    showA.show();
    showB.hide();
    expect(selectFloatingWidgetTarget(group, "b").plugin).toBe(a);
    expect(selectFloatingWidgetTarget(group, "b").widget.visible).toBe(true);
    await Promise.all([a.cleanup(), b.cleanup()]);
    Reflect.deleteProperty(globalThis, "__floating_a");
    Reflect.deleteProperty(globalThis, "__floating_b");
  });

  it.each([
    ["size: { width: 0, height: 10 }", "size"],
    ['initialPosition: "outside"', "initial position"],
    ['initiallyVisible: "yes"', "visibility"],
    ['chrome: "window"', "chrome"],
    ['Component: "div"', "component"],
  ])("rejects an invalid floating widget (%s)", (options, message) => {
    expect(() =>
      evaluatePluginClientBundle(
        "pet",
        bundle(`
      plugin.addFloatingWidget({ id: "pet", title: "Pet", Component() { return null; }, ${options} });
    `),
      ),
    ).toThrow(message);
  });

  it("rejects duplicate widget ids and allows ids to be reused after removal", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "pet",
        bundle(`
      const input = { id: "pet", title: "Pet", Component() { return null; } };
      plugin.addFloatingWidget(input);
      plugin.addFloatingWidget(input);
    `),
      ),
    ).toThrow("Duplicate floating widget");
    const plugin = evaluatePluginClientBundle(
      "pet",
      bundle(`
      const input = { id: "pet", title: "Pet", Component: require("react").memo(() => null) };
      plugin.addFloatingWidget(input).remove();
      plugin.addFloatingWidget(input);
    `),
    );
    expect(plugin.floatingWidgets).toHaveLength(1);
  });

  it("releases button registrations when client setup throws", () => {
    let active = 0;
    function addButton() {
      active++;
      return {
        update() {},
        remove() {
          active--;
        },
      };
    }
    expect(() =>
      runPluginClientBundle(
        "failed-buttons",
        bundle(`
      plugin.addHeaderButton({ id: "header", workspaceId: "workspace", button: { title: "Header", icon: "Scan", behavior: { kind: "action", onPress() {} } } });
      plugin.addComposerPill({ id: "pill", workspaceId: "workspace", agentId: "agent", button: { title: "Pill", icon: "Scan", behavior: { kind: "action", onPress() {} } } });
      throw new Error("Setup failed");
    `),
        { ...runtime, addHeaderButton: addButton, addComposerPill: addButton },
      ),
    ).toThrow("Setup failed");
    expect(active).toBe(0);
  });

  it("accepts memoized settings screens", () => {
    const plugin = evaluatePluginClientBundle(
      "settings",
      bundle(`
        const Component = require("react").memo(function Settings() { return null; });
        plugin.addSettingsScreen({ id: "display", title: "Display", icon: "Settings", Component });
      `),
    );
    expect(plugin.settingsScreens.map((screen) => screen.id)).toEqual(["display"]);
  });

  it("returns idempotent removers for every client registration", () => {
    let pillCount = 0;
    const plugin = runPluginClientBundle(
      "removals",
      bundle(`
        function Component() { return null; }
        const schema = { safeParse(value) { return { success: true, data: value }; } };
        globalThis.__pluginRemovals = [
          plugin.addScreen({ id: "main", title: "Main", Component }),
          plugin.addSettingsScreen({ id: "display", title: "Display", icon: "Settings", Component }),
          plugin.addSidebarHeaderItem({ id: "main", title: "Main", Component }),
          plugin.addSidebarFooterItem({ id: "status", title: "Status", Component }),
          plugin.addWorkspacePanel({ id: "panel", title: "Panel", icon: "Blocks", context: "workspace", Component }),
          plugin.addCommandCenterItem({ id: "command", title: "Command", icon: "Blocks", context: "global", onSelect() {} }),
          plugin.addSlashCommand({ name: "review", description: "Review", argumentHint: "", context: "workspace", onSubmit() {} }),
          plugin.addComposerPill({ id: "pill", workspaceId: "workspace", agentId: "agent", button: { title: "Pill", icon: "Scan", behavior: { kind: "action", onPress() {} } } }).remove,
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
          return {
            update() {},
            remove() {
              pillCount -= 1;
            },
          };
        },
      },
    );
    const removals = Reflect.get(globalThis, "__pluginRemovals") as Array<() => void>;

    expect(
      [
        plugin.surfaces,
        plugin.settingsScreens,
        plugin.sidebarItems.header,
        plugin.sidebarItems.footer,
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
        plugin.settingsScreens,
        plugin.sidebarItems.header,
        plugin.sidebarItems.footer,
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

  it.each(["tool_call", "notification"])("collects %s transformers and renderers", (itemType) => {
    const plugin = evaluatePluginClientBundle(
      "reports",
      bundle(`
        function Card() { return null; }
        const schema = { safeParse(value) { return { success: true, data: value }; } };
        plugin.addTimelineTransformer({
          id: "test-report",
          query: { itemType: "${itemType}" },
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
      { id: "test-report", query: { itemType } },
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

  it("collects screens and sidebar header and footer items", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      bundle(`
        function Screen() { return null; }
        const Item = require("react").memo(function Item() { return null; });
        plugin.addScreen({ id: "main", title: " Main ", Component: Screen });
        plugin.addScreen({ id: "bot", title: (params) => params.botId, Component: Screen });
        plugin.addSidebarHeaderItem({ id: "main", title: " Example ", Component: Item });
        plugin.addSidebarFooterItem({ id: "main", title: "Status", Component: Item });
      `),
    );

    expect(plugin.id).toBe("example");
    expect(plugin.surfaces.map((surface) => surface.id)).toEqual(["main", "bot"]);
    expect(plugin.surfaces[0]?.title).toBe("Main");
    expect(plugin.surfaces[1]?.title).toBeTypeOf("function");
    expect(plugin.sidebarItems.header.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "main", title: "Example" },
    ]);
    expect(plugin.sidebarItems.footer.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "main", title: "Status" },
    ]);
    expect(plugin.legacySidebarItems).toEqual([]);
  });

  it.each([
    [`plugin.addScreen("main", Screen);`, "addScreen takes { id, title, Component }"],
    [`plugin.addScreen({ id: "main", Component: Screen });`, "Screen main needs a title"],
    [
      `plugin.addScreen({ id: "main", title: " ", Component: Screen });`,
      "Screen main needs a title",
    ],
    [
      `plugin.addScreen({ id: "main", title: 42, Component: Screen });`,
      "Screen main needs a title",
    ],
    [
      `plugin.addScreen({ id: "main", title: "Main", Component: "Main" });`,
      "Screen main is not a component",
    ],
  ])("rejects a malformed screen: %s", (call, message) => {
    expect(() =>
      evaluatePluginClientBundle("example", bundle(`function Screen() { return null; } ${call}`)),
    ).toThrow(message);
  });

  it("rejects duplicate and malformed sidebar items within a section", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        bundle(`
          function Item() { return null; }
          plugin.addSidebarFooterItem({ id: "main", title: "One", Component: Item });
          plugin.addSidebarFooterItem({ id: "main", title: "Two", Component: Item });
        `),
      ),
    ).toThrow("Duplicate sidebar footer item: main");
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        bundle(`plugin.addSidebarHeaderItem({ id: "main", title: "Main", Component: "Main" });`),
      ),
    ).toThrow("Sidebar item main is not a component");
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        bundle(
          `plugin.addSidebarHeaderItem({ id: "main", title: " ", Component() { return null; } });`,
        ),
      ),
    ).toThrow("Sidebar item main has no title");
  });

  it("expands the addSurface and addSidebarItem aliases to a screen and a legacy header item", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      bundle(`
        function Surface() { return null; }
        plugin.addSurface("main", Surface);
        plugin.addSidebarItem({ id: "entry", title: "Example", icon: "Blocks", surface: "main" });
      `),
    );

    expect(plugin.surfaces.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "main", title: "main" },
    ]);
    expect(plugin.sidebarItems).toEqual({ header: [], footer: [] });
    expect(plugin.legacySidebarItems).toEqual([
      { id: "entry", title: "Example", icon: "Blocks", surface: "main" },
    ]);
  });

  it("releases an addSidebarItem alias's header id", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      bundle(`
        plugin.addScreen({ id: "main", title: "Main", Component: function Screen() { return null; } });
        const remove = plugin.addSidebarItem({ id: "entry", title: "Example", icon: "Blocks", surface: "main" });
        remove();
        plugin.addSidebarHeaderItem({ id: "entry", title: "Replacement", Component() { return null; } });
      `),
    );

    expect(plugin.sidebarItems.header.map((item) => item.title)).toEqual(["Replacement"]);
    expect(plugin.legacySidebarItems).toEqual([]);
  });

  it("rejects a header item that reuses an addSidebarItem id", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        bundle(`
          plugin.addScreen({ id: "main", title: "Main", Component: function Screen() { return null; } });
          plugin.addSidebarItem({ id: "entry", title: "Example", icon: "Blocks", surface: "main" });
          plugin.addSidebarHeaderItem({ id: "entry", title: "Other", Component() { return null; } });
        `),
      ),
    ).toThrow("Duplicate sidebar header item: entry");
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

  it("registers workspace and agent panels with stable aliases", () => {
    const plugin = evaluatePluginClientBundle(
      "panels",
      bundle(`
      const Component = () => null;
      plugin.addWorkspacePanel({ id: "workspace", title: "Workspace", icon: "File", Component });
      plugin.addAgentPanel({ id: "agent", title: "Agent", icon: "File", Component });
      plugin.addWorkspacePanel({ id: "legacy", title: "Legacy", icon: "File", context: "agent", Component });
    `),
    );
    expect(plugin.workspacePanels.map(({ id, context }) => ({ id, context }))).toEqual([
      { id: "workspace", context: "workspace" },
      { id: "agent", context: "agent" },
      { id: "legacy", context: "agent" },
    ]);
  });

  it("registers inline SVG and component icons", () => {
    const svg = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z" /></svg>';
    const plugin = evaluatePluginClientBundle(
      "review",
      bundle(`
        function ReviewPanel() { return null; }
        function BadgeIcon() { return null; }
        plugin.addWorkspacePanel({
          id: "review",
          title: "Review",
          icon: { svg: ${JSON.stringify(`  ${svg}\n`)} },
          context: "workspace",
          Component: ReviewPanel,
        });
        plugin.addCommandCenterItem({
          id: "open-review",
          title: "Open review",
          icon: BadgeIcon,
          context: "global",
          onSelect() {},
        });
        plugin.addAttachmentSource({
          id: "issues",
          title: "Issues",
          icon: { svg: ${JSON.stringify(svg)} },
          pickerTitle: "Attach issue",
          searchPlaceholder: "Search",
          search: { name: "issues.search", input: {}, output: {} },
        });
      `),
    );

    expect(plugin.workspacePanels[0]?.icon).toEqual({ svg });
    expect(plugin.commandCenterItems[0]?.icon).toHaveProperty("name", "BadgeIcon");
    expect(plugin.attachmentSources[0]?.icon).toEqual({ svg });
  });

  it.each([
    [
      "workspace panel",
      `plugin.addWorkspacePanel({ id: "review", title: "Review", icon: ICON, context: "workspace", Component() { return null; } })`,
      "Workspace panel review has an invalid icon: script elements are not allowed",
    ],
    [
      "Command Center item",
      `plugin.addCommandCenterItem({ id: "review", title: "Review", icon: ICON, context: "global", onSelect() {} })`,
      "Command Center item review has an invalid icon: script elements are not allowed",
    ],
    [
      "settings screen",
      `plugin.addSettingsScreen({ id: "review", title: "Review", icon: ICON, Component() { return null; } })`,
      "Settings screen review has an invalid icon: script elements are not allowed",
    ],
    [
      "attachment source",
      `plugin.addAttachmentSource({ id: "review", title: "Review", icon: ICON, pickerTitle: "Pick", searchPlaceholder: "Search", search: { name: "issues.search", input: {}, output: {} } })`,
      "Attachment source review has an invalid icon: script elements are not allowed",
    ],
  ])("fails the plugin when a %s registers an unsafe SVG", (_kind, registration, message) => {
    const icon = JSON.stringify({ svg: "<svg><script>run()</script></svg>" });

    expect(() =>
      evaluatePluginClientBundle("review", bundle(registration.replace("ICON", icon))),
    ).toThrow(message);
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

  it("provides the host Icon component through @getpaseo/plugin/client/ui", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { Icon } = require("@getpaseo/plugin/client/ui");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          plugin.addScreen({ id: "main", title: "Main", Component: function Surface() {
            return Icon({ name: "Settings", size: 18, color: "#123456" });
          } });
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

  it("provides Paseo UI through @getpaseo/plugin/client/ui", () => {
    const plugin = evaluatePluginClientBundle(
      "example",
      `(function(require) {
        const { Icon, Modal, useToast, SettingsSection, SidebarRow, StreamedText } = require("@getpaseo/plugin/client/ui");
        const module = { exports: {} };
        module.exports.default = function(plugin) {
          if (typeof Icon !== "function" || typeof Modal !== "function" || typeof Modal.Content !== "function" || typeof useToast !== "function" || typeof SettingsSection !== "function" || typeof SidebarRow !== "function" || typeof StreamedText !== "function") {
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

  it("keeps the host reveal hook on the deprecated client/react-native entry", () => {
    const plugin = evaluatePluginClientBundle(
      "legacy-reveal",
      bundle(`
        const legacy = require("@getpaseo/plugin/client/react-native");
        const ui = require("@getpaseo/plugin/client/ui");
        if (typeof legacy.useRevealedText !== "function") throw new Error("Missing legacy reveal hook");
        if (legacy.StreamedText !== ui.StreamedText) throw new Error("Missing current UI exports");
        if ("useRevealedText" in ui) throw new Error("Legacy hook leaked into current UI");
        plugin.addScreen({ id: "reveal", title: "Reveal", Component: legacy.useRevealedText });
      `),
    );
    expect(plugin.surfaces[0]?.Component).toBe(useRevealedText);
  });

  it("keeps shared and client runtime exports separate", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        `(function(require) {
      const shared = require("@getpaseo/plugin");
      const client = require("@getpaseo/plugin/client");
      const { ExternalLink, Loading, Markdown } = require("@getpaseo/plugin/client/ui");
      if (typeof Markdown !== "function") throw new Error("Markdown");
      if (typeof ExternalLink !== "function") throw new Error("ExternalLink");
      if (typeof Loading !== "function") throw new Error("Loading");
      for (const name of ["usePaseo", "useRpc", "useSettings", "useAgent", "useWorkspace", "openExternalUrl", "useFileText", "useFileBytes", "useFileUrl", "PluginFileConflictError", "PluginFileDeletedError"]) {
        if (name in shared || typeof client[name] !== "function") throw new Error(name);
      }
      if ("Icon" in shared || typeof shared.PluginAttachmentItemSchema.parse !== "function") throw new Error("shared exports");
      return { default() { return () => {}; } };
    })`,
      ),
    ).not.toThrow();
  });

  it.each([
    "@getpaseo/plugin/server",
    "@getpaseo/plugin/server/provider",
    "@getpaseo/plugin/server/acp",
    "@getpaseo/plugin/client/host",
    "@getpaseo/plugin/react-native",
    "@getpaseo/plugin/ui",
    "@getpaseo/plugin/host",
    "@paseo/plugin",
  ])("rejects %s in the client loader", (specifier) => {
    expect(() =>
      evaluatePluginClientBundle(
        "example",
        `(function(require) { require("${specifier}"); return {}; })`,
      ),
    ).toThrow("not available in plugin client code");
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

it("binds imported getters to each originating installation across delayed callbacks", async () => {
  const calls: string[] = [];
  const hostRuntime = (installation: string): PluginClientRuntime => ({
    ...runtime,
    hosts: {
      getSnapshot: () => [],
      subscribe: () => () => {},
      getPaseoClient(serverId) {
        calls.push(`${installation}/${serverId}`);
        return runtime.paseo;
      },
    },
  });
  const source = bundle(`
    const { getPaseoClient } = require("@getpaseo/plugin/client");
    getPaseoClient("entry-host");
    plugin.addCommandCenterItem({
      id: "read", title: "Read", icon: "Server", context: "global",
      onSelect: async () => { await Promise.resolve(); getPaseoClient("target-host"); },
    });
  `);
  const first = runPluginClientBundle("same-id", source, hostRuntime("first"));
  const second = runPluginClientBundle("same-id", source, hostRuntime("second"));
  // Both callbacks run after the second bundle has evaluated.
  await first.commandCenterItems[0].onSelect({} as never);
  await second.commandCenterItems[0].onSelect({} as never);
  expect(calls).toEqual([
    "first/entry-host",
    "second/entry-host",
    "first/target-host",
    "second/target-host",
  ]);
  await first.cleanup();
  await second.cleanup();
});

describe("file panels", () => {
  const panel =
    '{ id: "pdf", title: "PDF", icon: "FileText", files: { extensions: ["pdf"] }, Component() { return null; } }';
  it("registers a panel and removes it on cleanup", async () => {
    const plugin = evaluatePluginClientBundle("files", bundle(`plugin.addFilePanel(${panel})`));
    expect(plugin.filePanels.map(({ id, title, files }) => ({ id, title, files }))).toEqual([
      { id: "pdf", title: "PDF", files: { extensions: ["pdf"] } },
    ]);
    await plugin.cleanup();
    expect(plugin.filePanels).toEqual([]);
  });
  it.each([
    ['files: { extensions: ["pdf"] }', 'files: { pattern: "*.pdf" }', "selector"],
    ['files: { extensions: ["pdf"] }', 'files: { extensions: [".pdf"] }', "selector"],
    ['files: { extensions: ["pdf"] }', 'files: { extensions: ["*"] }', "selector"],
    ['files: { extensions: ["pdf"] }', 'files: { extensions: ["foo/bar"] }', "selector"],
    ['files: { extensions: ["pdf"] }', "files: { extensions: [] }", "selector"],
    ['files: { extensions: ["pdf"] }', 'files: { extensions: [], filenames: ["a/b"] }', "selector"],
    ['id: "pdf"', 'id: "Bad"', "file panel id"],
    ['title: "PDF"', 'title: " "', "title"],
    ["Component() { return null; }", "Component: {}", "component"],
    ['icon: "FileText"', 'icon: ""', "icon"],
  ])("rejects invalid registration %s → %s", (from, to, error) => {
    expect(() =>
      evaluatePluginClientBundle(
        "files",
        bundle(`plugin.addFilePanel(${panel.replace(from, to)})`),
      ),
    ).toThrow(error);
  });
  it("accepts filename selectors and rejects duplicate IDs", () => {
    const source = panel.replace(
      'extensions: ["pdf"]',
      'extensions: [], filenames: ["Dockerfile"]',
    );
    const plugin = evaluatePluginClientBundle("files", bundle(`plugin.addFilePanel(${source})`));
    expect(plugin.filePanels[0]?.files).toEqual({ extensions: [], filenames: ["Dockerfile"] });
    expect(() =>
      evaluatePluginClientBundle(
        "files",
        bundle(`plugin.addFilePanel(${source}); plugin.addFilePanel(${source})`),
      ),
    ).toThrow("Duplicate file panel");
  });
});
