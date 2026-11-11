import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oxlintBin = path.join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = path.join(repoRoot, "scripts/oxlint/paseo-plugin.mjs");

function lint(source) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-oxlint-"));
  try {
    writeFileSync(
      path.join(dir, ".oxlintrc.json"),
      JSON.stringify({ jsPlugins: [pluginPath], rules: { "paseo/no-raw-pressable": "error" } }),
    );
    writeFileSync(path.join(dir, "probe.tsx"), source);
    const result = spawnSync(oxlintBin, ["-c", ".oxlintrc.json", "probe.tsx"], {
      cwd: dir,
      encoding: "utf8",
    });
    return { failed: result.status !== 0, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a raw Pressable from react-native is reported", () => {
  const result = lint(
    'import { Pressable, View } from "react-native";\nexport { Pressable, View };\n',
  );
  assert.equal(result.failed, true);
  assert.match(result.output, /no-raw-pressable/);
});

test("an aliased gesture-handler touchable is reported", () => {
  const result = lint(
    'import { TouchableOpacity as Tap } from "react-native-gesture-handler";\nexport { Tap };\n',
  );
  assert.equal(result.failed, true);
  assert.match(result.output, /no-raw-pressable/);
});

test("press primitives and pressable types are allowed", () => {
  const result = lint(
    'import { View, type PressableProps } from "react-native";\n' +
      'import { ToolbarButton } from "@/components/ui/pane-content-toolbar";\n' +
      "export type Props = PressableProps;\nexport { View, ToolbarButton };\n",
  );
  assert.equal(result.failed, false, result.output);
});
