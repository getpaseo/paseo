import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SOURCE_ROOT = path.join(APP_ROOT, "src");
const EVENT_NAMES = [
  "onHoverIn",
  "onHoverOut",
  "onPressIn",
  "onPressOut",
  "onPointerEnter",
  "onPointerLeave",
];

function listProductionSourceFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      listProductionSourceFiles(filePath, files);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) {
      continue;
    }
    if (entry.name === "terminal-emulator-webview-html.ts") {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

function collectBindingNames(name, names = []) {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return names;
  }
  for (const element of name.elements ?? []) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, names);
    }
  }
  return names;
}

function isInteractionStateName(name) {
  return /^(is|set)?(hover|press)/i.test(name) || /Hover|Press/.test(name);
}

function classifySourceGroup(relativePath) {
  if (relativePath.includes("/components/ui/")) return "ui-primitives";
  if (relativePath.includes("/sidebar") || relativePath.endsWith("/components/left-sidebar.tsx")) {
    return "sidebar";
  }
  if (
    relativePath.includes("/screens/workspace/") ||
    relativePath.endsWith("/screens/workspace-screen.tsx") ||
    relativePath.endsWith("/components/split-container.tsx")
  ) {
    return "workspace-chrome";
  }
  if (relativePath.includes("/composer/")) return "composer";
  if (relativePath.includes("/git/") || relativePath.includes("/review/")) {
    return "git-diff-review";
  }
  if (
    relativePath.endsWith("/components/message.tsx") ||
    relativePath.includes("/agent-stream/") ||
    relativePath.includes("/subagents/")
  ) {
    return "timeline-subagents";
  }
  if (
    relativePath.includes("/settings") ||
    relativePath.includes("/new-workspace") ||
    relativePath.includes("/open-project") ||
    relativePath.includes("/add-project") ||
    relativePath.includes("/hosts/")
  ) {
    return "settings-create-flows";
  }
  return "other-components";
}

function createGroup() {
  return {
    callbackSites: 0,
    hoverCallbackSites: 0,
    pressCallbackSites: 0,
    files: new Set(),
  };
}

function isInteractionStateDeclaration(node, sourceFile) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isArrayBindingPattern(node.name) ||
    !node.initializer ||
    !ts.isCallExpression(node.initializer)
  ) {
    return false;
  }
  return (
    node.initializer.expression.getText(sourceFile).endsWith("useState") &&
    collectBindingNames(node.name).some(isInteractionStateName)
  );
}

function readInteractionCallback(node) {
  const isFunctionLike =
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node);
  if (!isFunctionLike || !node.parameters[0]) {
    return null;
  }
  const parameterName = node.parameters[0].name;
  if (ts.isObjectBindingPattern(parameterName)) {
    const names = collectBindingNames(parameterName);
    const usesHover = names.some((name) => /^(hovered|isHovered)$/i.test(name));
    const usesPress = names.some((name) => /^(pressed|isPressed)$/i.test(name));
    return usesHover || usesPress ? { usesHover, usesPress } : null;
  }
  if (!ts.isIdentifier(parameterName) || !node.body) {
    return null;
  }
  let usesHover = false;
  let usesPress = false;
  function visitPropertyAccess(child) {
    if (
      ts.isPropertyAccessExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === parameterName.text
    ) {
      usesHover ||= /^(hovered|isHovered)$/i.test(child.name.text);
      usesPress ||= /^(pressed|isPressed)$/i.test(child.name.text);
    }
    ts.forEachChild(child, visitPropertyAccess);
  }
  visitPropertyAccess(node.body);
  return usesHover || usesPress ? { usesHover, usesPress } : null;
}

const sourceFiles = listProductionSourceFiles(APP_SOURCE_ROOT);
const eventCounts = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0]));
const interactionStateFiles = new Set();
const callbackFiles = new Set();
const groups = new Map();
let interactionStateCells = 0;
let callbackSites = 0;
let hoverCallbackSites = 0;
let pressCallbackSites = 0;

for (const filePath of sourceFiles) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const relativePath = path.relative(APP_ROOT, filePath);

  function visit(node) {
    if (ts.isJsxAttribute(node) && EVENT_NAMES.includes(node.name.text)) {
      eventCounts[node.name.text] += 1;
    }

    if (isInteractionStateDeclaration(node, sourceFile)) {
      interactionStateCells += 1;
      interactionStateFiles.add(relativePath);
    }

    const interactionCallback = readInteractionCallback(node);
    if (interactionCallback) {
      callbackSites += 1;
      hoverCallbackSites += interactionCallback.usesHover ? 1 : 0;
      pressCallbackSites += interactionCallback.usesPress ? 1 : 0;
      callbackFiles.add(relativePath);
      const groupName = classifySourceGroup(relativePath);
      const group = groups.get(groupName) ?? createGroup();
      group.callbackSites += 1;
      group.hoverCallbackSites += interactionCallback.usesHover ? 1 : 0;
      group.pressCallbackSites += interactionCallback.usesPress ? 1 : 0;
      group.files.add(relativePath);
      groups.set(groupName, group);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const metric = (value) => ({ unit: "count", values: { total: value } });
const cases = [
  {
    id: "overall",
    dimensions: { scope: "packages/app/src production TypeScript" },
    metrics: {
      sourceFilesScanned: metric(sourceFiles.length),
      interactionCallbackSites: metric(callbackSites),
      hoverCallbackSites: metric(hoverCallbackSites),
      pressCallbackSites: metric(pressCallbackSites),
      callbackFiles: metric(callbackFiles.size),
      interactionStateCells: metric(interactionStateCells),
      interactionStateFiles: metric(interactionStateFiles.size),
      hoverTrackerPairs: metric(eventCounts.onHoverIn + eventCounts.onPointerEnter),
      pressPhaseBindings: metric(eventCounts.onPressIn + eventCounts.onPressOut),
      ...Object.fromEntries(EVENT_NAMES.map((name) => [name, metric(eventCounts[name])])),
    },
  },
  ...Array.from(groups.entries())
    .sort((left, right) => right[1].callbackSites - left[1].callbackSites)
    .map(([groupName, group]) => ({
      id: groupName,
      dimensions: { group: groupName },
      metrics: {
        interactionCallbackSites: metric(group.callbackSites),
        hoverCallbackSites: metric(group.hoverCallbackSites),
        pressCallbackSites: metric(group.pressCallbackSites),
        sourceFiles: metric(group.files.size),
      },
    })),
];

const output = {
  schemaVersion: 1,
  taskId: "desktop-css-interaction-audit",
  generatedAt: new Date().toISOString(),
  metadata: {
    scanner: "typescript-ast-v1",
    generatedTerminalBundleExcluded: true,
    testsExcluded: true,
  },
  cases,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (process.env.PASEO_BENCHMARK_OUTPUT) {
  writeFileSync(process.env.PASEO_BENCHMARK_OUTPUT, serialized);
}
if (process.env.PASEO_BENCHMARK_QUIET !== "1") {
  process.stdout.write(serialized);
}
