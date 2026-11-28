#!/usr/bin/env node
// Copies an upstream package's `Common/cpp` into a build directory and applies a
// unified diff to the copy, so the app's node_modules is never modified.
//
//   node patch-sources.mjs <package root> <patch file> <output dir>
//
// Prints the patched `Common/cpp` directory. The copy is reused while the
// package version and the patch are unchanged.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parses a unified diff into files, each with its hunks. */
export function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  // Lines still expected in the current hunk, from its header counts.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.replace(/\r\n/gu, '\n').split('\n')) {
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const kind = line.length === 0 ? ' ' : line[0];
      const body = line.slice(1);
      if (kind === ' ' || kind === '-') {
        hunk.old.push(body);
        oldLeft--;
      }
      if (kind === ' ' || kind === '+') {
        hunk.new.push(body);
        newLeft--;
      }
      if (kind === '\\') continue;
    } else if (line.startsWith('--- ')) {
      file = { path: null, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (line.startsWith('+++ ') && file !== null) {
      file.path = line.slice(4).split('\t')[0].replace(/^b\//u, '');
    } else if (line.startsWith('@@ ') && file !== null) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
      if (match === null) throw new Error(`bad hunk header: ${line}`);
      hunk = { start: Number(match[1]), old: [], new: [] };
      oldLeft = match[2] === undefined ? 1 : Number(match[2]);
      newLeft = match[3] === undefined ? 1 : Number(match[3]);
      file.hunks.push(hunk);
    }
  }
  return files;
}

function matchesAt(lines, block, at) {
  if (at < 0 || at + block.length > lines.length) return false;
  return block.every((line, i) => lines[at + i] === line);
}

/** The line nearest `expected` where `block` starts, or -1. */
function find(lines, block, expected) {
  for (let delta = 0; delta <= lines.length; delta++) {
    if (matchesAt(lines, block, expected - delta)) return expected - delta;
    if (matchesAt(lines, block, expected + delta)) return expected + delta;
  }
  return -1;
}

/**
 * Applies one file's hunks to its text, keeping its line endings. A hunk whose
 * result is already present
 * is skipped, so sources that carry the fix upstream still build; any other
 * mismatch throws.
 */
export function applyHunks(text, hunks, name) {
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  let offset = 0;
  for (const hunk of hunks) {
    const expected = Math.max(hunk.start - 1, 0) + offset;
    const at = find(lines, hunk.old, expected);
    if (at !== -1) {
      lines.splice(at, hunk.old.length, ...hunk.new);
      offset = at - (hunk.start - 1) + hunk.new.length - hunk.old.length;
      continue;
    }
    const applied = find(lines, hunk.new, expected);
    if (applied === -1) {
      throw new Error(`${name}: hunk at line ${hunk.start} does not apply`);
    }
    offset = applied - (hunk.start - 1);
  }
  return lines.join(crlf ? '\r\n' : '\n');
}

function main([packageRoot, patchFile, outputDir]) {
  if (!packageRoot || !patchFile || !outputDir) {
    throw new Error(
      'usage: patch-sources.mjs <package root> <patch file> <output dir>',
    );
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const patch = fs.readFileSync(patchFile, 'utf8');
  const stamp = createHash('sha256')
    .update(`${manifest.name}@${manifest.version}\n`)
    .update(patch)
    .digest('hex');
  const target = path.join(outputDir, 'Common', 'cpp');
  const stampFile = path.join(outputDir, '.patched');
  const current = fs.existsSync(stampFile)
    ? fs.readFileSync(stampFile, 'utf8')
    : '';
  if (current !== stamp) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.cpSync(path.join(packageRoot, 'Common', 'cpp'), target, {
      recursive: true,
    });
    for (const file of parsePatch(patch)) {
      const full = path.join(target, file.path);
      const original = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      let patched;
      try {
        patched = applyHunks(original, file.hunks, file.path);
      } catch (error) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        throw new Error(
          `${path.basename(patchFile)} does not apply to ${manifest.name}@${manifest.version}: ${error.message}`,
        );
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, patched);
    }
    fs.writeFileSync(stampFile, stamp);
  }
  // CMake reads backslashes as escapes.
  process.stdout.write(target.split(path.sep).join('/'));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
