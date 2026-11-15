#!/usr/bin/env node
// Writes src/projects/radix-glyphs.ts from the published @radix-ui/react-icons package.
//
//   node packages/app/scripts/generate-radix-glyphs.mjs [version]
//
// The package ships no raw SVG files, so the shapes are read back from the createElement calls
// in dist/react-icons.esm.js, and the kebab-case names come from manifest.json. Every shape is
// painted with the icon color, which the output leaves to an enclosing fill.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "1.3.2";
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..", "..");
const outFile = join(appDir, "src", "projects", "radix-glyphs.ts");

const ATTRIBUTES = { fillRule: "fill-rule", clipRule: "clip-rule" };
const SHAPES = new Set(["path", "rect", "circle"]);

const workDir = mkdtempSync(join(tmpdir(), "radix-icons-"));
try {
  run(
    "npm",
    ["pack", "--silent", `@radix-ui/react-icons@${version}`, "--pack-destination", workDir],
    workDir,
  );
  const tarball = readdirTarball(workDir);
  run("tar", ["-xzf", tarball, "-C", workDir], workDir);
  const glyphs = readGlyphs(join(workDir, "package"));
  writeFileSync(outFile, render(glyphs));
  run("npm", ["run", "format:files", "--", relative(repoRoot, outFile)], repoRoot);
  console.log(`${glyphs.length} glyphs from @radix-ui/react-icons ${version}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function readGlyphs(packageDir) {
  const source = readFileSync(join(packageDir, "dist", "react-icons.esm.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8"));
  const names = new Map(
    Object.keys(manifest.icons[":15"]).map((name) => [name.replaceAll("-", ""), name]),
  );
  const blocks = source.split(/\nvar (\w+)Icon = \/\*#__PURE__\*\/forwardRef/);
  const glyphs = [];
  for (let index = 1; index < blocks.length; index += 2) {
    const component = blocks[index];
    const name = names.get(component.toLowerCase());
    if (!name) throw new Error(`${component}: not in manifest.json`);
    const shapes = [];
    for (const [, tag, attributes] of blocks[index + 1].matchAll(
      /createElement\("(\w+)", \{(.*?)\}\)/gs,
    )) {
      if (tag === "svg") continue;
      if (!SHAPES.has(tag)) throw new Error(`${component}: unsupported <${tag}>`);
      shapes.push(`<${tag} ${readAttributes(component, attributes).join(" ")}/>`);
    }
    glyphs.push([name, shapes.join("")]);
  }
  // Code-point order, as the names are plain ASCII and unique.
  return glyphs.sort(([a], [b]) => (a < b ? -1 : 1));
}

function readAttributes(component, attributes) {
  const out = [];
  for (const [, key, value] of attributes.matchAll(/(\w+): ("[^"]*"|\w+)/g)) {
    if (key === "fill") {
      if (value !== "color") throw new Error(`${component}: unexpected fill ${value}`);
      continue;
    }
    if (!value.startsWith('"')) throw new Error(`${component}: ${key} is not a literal`);
    out.push(`${ATTRIBUTES[key] ?? key}=${value}`);
  }
  return out;
}

function render(glyphs) {
  return [
    `// Generated from @radix-ui/react-icons ${version} (MIT, Copyright (c) 2022 WorkOS).`,
    "// Regenerate with `node packages/app/scripts/generate-radix-glyphs.mjs`; do not edit by hand.",
    "// Each body is the inside of a 15×15 icon, painted by an enclosing fill.",
    "",
    `export const RADIX_GLYPH_VERSION = ${JSON.stringify(version)};`,
    "",
    "export const RADIX_GLYPHS: ReadonlyArray<readonly [name: string, body: string]> = [",
    ...glyphs.map(([name, body]) => `  [${JSON.stringify(name)}, ${JSON.stringify(body)}],`),
    "];",
    "",
  ].join("\n");
}

function readdirTarball(dir) {
  const tarball = readdirSync(dir).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  return join(dir, tarball);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}
