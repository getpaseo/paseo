import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// Bypass the app test aliases: they replace all three libraries involved in the leak.
async function renderWebProbe(contents: string) {
  const { outputFiles } = await build({
    stdin: {
      contents,
      resolveDir: path.resolve(import.meta.dirname, "../.."),
      loader: "jsx",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    mainFields: ["browser", "module", "main"],
    conditions: ["browser"],
    resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
    alias: { "react-native": "react-native-web", "@": path.resolve(import.meta.dirname, "..") },
    jsx: "automatic",
    define: { __DEV__: "true", "process.env.NODE_ENV": '"development"' },
  });
  return spawnSync(process.execPath, ["-"], {
    input: outputFiles[0].text,
    encoding: "utf8",
  });
}

describe("Unistyles web component props", () => {
  it("consumes uniProps while preserving mapped colors and explicit overrides", async () => {
    const result = await renderWebProbe(`
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { StyleSheet, UnistylesRuntime, withUnistyles } from 'react-native-unistyles';
          import { Server } from 'lucide-react-native';
          StyleSheet.configure({
            themes: { light: { color: 'red' }, dark: { color: 'blue' } },
            settings: { initialTheme: 'light' },
          });
          const Icon = withUnistyles(Server);
          const mapping = theme => ({ color: theme.color });
          const render = props => renderToStaticMarkup(React.createElement(Icon, { uniProps: mapping, ...props }));
          const light = render();
          UnistylesRuntime.setTheme('dark');
          const dark = render();
          const overridden = render({ color: 'green' });
          const received = [];
          const Probe = withUnistyles(props => { received.push(props); return null; });
          renderToStaticMarkup(React.createElement(Probe, { uniProps: mapping, id: 'probe' }));
          console.log(JSON.stringify({ light, dark, overridden, keys: Object.keys(received[0]).sort() }));
        `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("React does not recognize");
    const rendered = JSON.parse(result.stdout);
    expect(rendered.keys).toEqual(["color", "id", "ref"]);
    expect(rendered.light).toContain('stroke="red"');
    expect(rendered.dark).toContain('stroke="blue"');
    expect(rendered.overridden).toContain('stroke="green"');
  });
});

describe("decorative checks ring", () => {
  it("hides its SVG from web accessibility without forwarding native props", async () => {
    const result = await renderWebProbe(`
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { StyleSheet } from 'react-native-unistyles';
      import { ChecksRing } from './src/git/pull-request-panel/checks-ring';
      StyleSheet.configure({
        themes: { light: { colors: { surface3: 'gray', statusSuccess: 'green' } } },
        settings: { initialTheme: 'light' },
      });
      console.log(renderToStaticMarkup(React.createElement(ChecksRing, {
        size: 20, summary: { total: 1, parts: [{ status: 'success', count: 1 }] },
      })));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('aria-hidden="true"');
    expect(result.stdout).not.toContain("importantForAccessibility");
    expect(result.stdout).not.toContain("accessibilityElementsHidden");
    expect(result.stdout).toContain('stroke="green"');
    expect(result.stderr).not.toContain("React does not recognize");
  });
});
