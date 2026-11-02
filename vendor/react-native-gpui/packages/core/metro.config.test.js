import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const {
  findTreeRoot,
  makeMetroConfig,
  nodeModulesUpToTreeRoot,
} = require('./metro.config.js');

const roots = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-watch-'));
  roots.push(root);
  return root;
}

function mkdir(...parts) {
  const directory = path.join(...parts);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function workspace(root) {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'] }),
  );
}

describe('findTreeRoot', () => {
  test('finds the nearest directory holding .git', () => {
    const root = scratch();
    mkdir(root, '.git');
    expect(findTreeRoot(mkdir(root, 'packages/app/src'))).toBe(root);
  });

  test('finds a package.json that declares workspaces', () => {
    const root = scratch();
    workspace(root);
    expect(findTreeRoot(mkdir(root, 'packages/app'))).toBe(root);
  });

  test('ignores a package.json without workspaces', () => {
    const root = scratch();
    mkdir(root, '.git');
    const app = mkdir(root, 'packages/app');
    fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app"}');
    expect(findTreeRoot(app)).toBe(root);
  });

  test('returns the nearest root, not the outermost', () => {
    const outer = scratch();
    mkdir(outer, '.git');
    const inner = mkdir(outer, 'vendor/repo');
    mkdir(inner, '.git');
    expect(findTreeRoot(mkdir(inner, 'packages/app'))).toBe(inner);
  });

  test('returns null when there is no repository or workspace above', () => {
    expect(findTreeRoot(mkdir(scratch(), 'standalone'))).toBeNull();
  });
});

describe('nodeModulesUpToTreeRoot', () => {
  test('collects every node_modules up to a repository root', () => {
    const root = scratch();
    mkdir(root, '.git');
    const expected = [
      mkdir(root, 'node_modules'),
      mkdir(root, 'packages/app/node_modules'),
    ];
    const found = nodeModulesUpToTreeRoot(path.join(root, 'packages/app'));
    expect(found.sort()).toEqual(expected.sort());
  });

  test('stops at a workspace root', () => {
    const root = scratch();
    workspace(root);
    const expected = [
      mkdir(root, 'node_modules'),
      mkdir(root, 'packages/app/node_modules'),
    ];
    const found = nodeModulesUpToTreeRoot(path.join(root, 'packages/app'));
    expect(found.sort()).toEqual(expected.sort());
  });

  test('never includes a node_modules above the tree root', () => {
    const outer = scratch();
    const decoy = mkdir(outer, 'node_modules');
    const repo = mkdir(outer, 'repo');
    mkdir(repo, '.git');
    mkdir(repo, 'node_modules');
    const found = nodeModulesUpToTreeRoot(mkdir(repo, 'packages/app'));
    expect(found).not.toContain(decoy);
    expect(found.every(folder => folder.startsWith(repo + path.sep))).toBe(
      true,
    );
  });

  test('returns only its own node_modules without a tree root', () => {
    const root = scratch();
    const stray = mkdir(root, 'node_modules');
    const own = mkdir(root, 'standalone/node_modules');
    const found = nodeModulesUpToTreeRoot(path.dirname(own));
    expect(found).toEqual([own]);
    expect(found).not.toContain(stray);
  });
});

describe('makeMetroConfig', () => {
  const tester = path.resolve(__dirname, '../rn-gpui-tester');
  const config = makeMetroConfig({ projectRoot: tester });

  // When this package is linked, the default names a React Native copy that is
  // not in the app's graph, and RN's setup never runs.
  test('runs this package’s setup-env before the app entry', () => {
    expect(config.serializer.getModulesRunBeforeMainModule()).toEqual([
      path.join(__dirname, 'setup-env.js'),
    ]);
  });

  test('watches nothing outside the repository', () => {
    const repo = findTreeRoot(tester);
    expect(
      config.watchFolders.every(
        folder => folder === repo || folder.startsWith(repo + path.sep),
      ),
    ).toBe(true);
  });

  // When this package is linked, its own sources import `react`/`react-native`,
  // and a hierarchical lookup walks up from them into the linked tree's
  // `node_modules` — a second React in the app's bundle, which React rejects
  // with "Invalid hook call" as soon as a component runs. Resolution has to
  // come from `nodeModulesPaths` alone.
  test('does not walk up from an importer for its dependencies', () => {
    expect(config.resolver.disableHierarchicalLookup).toBe(true);
  });
});
