import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const script = path.resolve("scripts", "postinstall-patches.mjs");
const bin = path.resolve("node_modules", ".bin");
const packageName = "react-native-draggable-flatlist";
const patchFile = `${packageName}+4.0.3.patch`;

for (const platform of ["ios", "android"]) {
  test(`vendored Markdown ships ${platform} props generated from its native specs`, () => {
    const packageDir = path.resolve("packages/react-native-enriched-markdown");
    const output = mkdtempSync(path.join(tmpdir(), `markdown-${platform}-codegen-`));
    try {
      // includesGeneratedCode makes native builds use the shipped headers instead of
      // regenerating them from the TypeScript specs, so a spec edit must regenerate them.
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/react-native/scripts/generate-codegen-artifacts.js"),
          "-p",
          packageDir,
          "-t",
          platform,
          "-o",
          output,
          "-s",
          "library",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const header =
        platform === "ios"
          ? "ReactCodegen/EnrichedMarkdownTextSpec/Props.h"
          : "jni/react/renderer/components/EnrichedMarkdownTextSpec/Props.h";
      assert.equal(
        readFileSync(path.join(packageDir, platform, "generated", header), "utf8"),
        readFileSync(path.join(output, header), "utf8"),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}

function createCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-patches-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
  const packageDir = path.join(root, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "4.0.3" }),
  );
  writeFileSync(path.join(packageDir, "index.js"), "export const value = 1;\n");
  mkdirSync(path.join(root, "patches"));
  return { root, packageDir };
}

function writePatch(root, from, to) {
  const file = `node_modules/${packageName}/index.js`;
  writeFileSync(
    path.join(root, "patches", patchFile),
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `-export const value = ${from};`,
      `+export const value = ${to};`,
      "",
    ].join("\n"),
  );
}

function install(root, PATH = `${bin}${path.delimiter}${process.env.PATH}`) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}

test("a patch that changed since it was applied removes the package for a clean reinstall", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );

    writePatch(root, 1, 3);
    const result = install(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run npm install again/);
    assert.equal(existsSync(packageDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already applied patch leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing patch-package fails the install and leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    const result = install(root, root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to spawn/);
    assert.equal(existsSync(packageDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function loadReactFabricDispatchEvent(bundleName, isDev) {
  const bundlePath = path.resolve(
    "node_modules/react-native/Libraries/Renderer/implementations",
    bundleName,
  );
  const code = readFileSync(bundlePath, "utf8");
  const nodeRequire = createRequire(import.meta.url);
  let dispatchEvent = null;
  const warnings = [];
  const rawEventListeners = new Map();

  const nativeFabricUIManager = {
    createNode: () => ({}),
    cloneNodeWithNewChildren: () => ({}),
    cloneNodeWithNewChildrenAndProps: () => ({}),
    cloneNodeWithNewProps: () => ({}),
    createChildSet: () => ({}),
    appendChild: () => {},
    appendChildToSet: () => {},
    completeRoot: () => {},
    registerEventHandler: (fn) => {
      dispatchEvent = fn;
    },
    setIsJSResponder: () => {},
    clearIsJSResponder: () => {},
    unstable_DiscreteEventPriority: 1,
    unstable_ContinuousEventPriority: 2,
    unstable_IdleEventPriority: 3,
    unstable_getCurrentEventPriority: () => 1,
  };

  const privateInterface = {
    ReactNativeViewConfigRegistry: {
      get: () => ({}),
      customBubblingEventTypes: {
        topTouchStart: {
          phasedRegistrationNames: { bubbled: "onTouchStart", captured: "onTouchStartCapture" },
        },
        topTouchMove: {
          phasedRegistrationNames: { bubbled: "onTouchMove", captured: "onTouchMoveCapture" },
        },
        topTouchEnd: {
          phasedRegistrationNames: { bubbled: "onTouchEnd", captured: "onTouchEndCapture" },
        },
        topTouchCancel: {
          phasedRegistrationNames: { bubbled: "onTouchCancel", captured: "onTouchCancelCapture" },
        },
        topSelectionChange: {
          phasedRegistrationNames: {
            bubbled: "onSelectionChange",
            captured: "onSelectionChangeCapture",
          },
        },
      },
      customDirectEventTypes: {},
    },
    RawEventEmitter: {
      emit: (name, payload) => {
        for (const fn of rawEventListeners.get(name) ?? []) {
          fn(payload);
        }
      },
    },
    UIManager: {},
    deepDiffer: () => false,
    flattenStyle: (s) => s,
    getNativeTagFromPublicInstance: () => null,
    getNodeFromPublicInstance: () => null,
    legacySendAccessibilityEvent: () => {},
    createPublicInstance: (tag) => ({ _nativeTag: tag }),
    createPublicTextInstance: () => ({}),
    ReactFiberErrorDialog: { showErrorDialog: () => true },
    Platform: { OS: "android" },
  };

  const customRequire = (id) => {
    if (id === "react") {
      return nodeRequire("react");
    }
    if (id === "scheduler") {
      return nodeRequire("scheduler");
    }
    if (id === "react-native/Libraries/ReactPrivate/ReactNativePrivateInitializeCore") {
      return {};
    }
    if (id === "react-native/Libraries/ReactPrivate/ReactNativePrivateInterface") {
      return privateInterface;
    }
    return nodeRequire(id);
  };

  const moduleObj = { exports: {} };
  const sandbox = {
    __DEV__: isDev,
    console: {
      ...console,
      warn: (...args) => warnings.push(args.join(" ")),
      error: (...args) => warnings.push(args.join(" ")),
    },
    exports: moduleObj.exports,
    module: moduleObj,
    nativeFabricUIManager,
    performance,
    queueMicrotask,
    require: customRequire,
    setTimeout,
    clearTimeout,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(code, sandbox, { filename: bundleName });
  assert.equal(
    typeof dispatchEvent,
    "function",
    `Expected ${bundleName} to register dispatchEvent`,
  );
  return { dispatchEvent, warnings };
}

function createHostFiber(type, props, parent = null) {
  const publicInstance = { _nativeTag: Math.floor(Math.random() * 100000) + 1 };
  return {
    tag: 5,
    type,
    return: parent,
    alternate: null,
    stateNode: {
      canonical: {
        currentProps: props,
        publicInstance,
        publicInstanceType: 0,
      },
    },
  };
}

function makeTouch(identifier, timestamp) {
  return {
    identifier,
    target: 1,
    pageX: 100,
    pageY: 100,
    locationX: 10,
    locationY: 10,
    timestamp,
  };
}

for (const [bundleName, isDev] of [
  ["ReactFabric-dev.js", true],
  ["ReactFabric-prod.js", false],
  ["ReactFabric-profiling.js", false],
]) {
  test(`${bundleName} reconciles trackedTouchCount from nativeEvent.touches after a dropped touch end`, () => {
    const { dispatchEvent, warnings } = loadReactFabricDispatchEvent(bundleName, isDev);
    const rootFiber = createHostFiber("RCTView", {});
    let inputGrants = 0;
    let buttonGrants = 0;
    const inputFiber = createHostFiber(
      "PasteTextInput",
      {
        onSelectionChangeShouldSetResponder: () => true,
        onResponderGrant: () => {
          inputGrants += 1;
        },
      },
      rootFiber,
    );
    const buttonFiber = createHostFiber(
      "RCTView",
      {
        onStartShouldSetResponder: () => true,
        onResponderGrant: () => {
          buttonGrants += 1;
        },
      },
      rootFiber,
    );

    // 1. Unmatched touch start (e.g. Modal dismissed while touch is down or double ACTION_DOWN).
    const orphanTouch = makeTouch(0, 1);
    dispatchEvent(rootFiber, "topTouchStart", {
      touches: [orphanTouch],
      changedTouches: [orphanTouch],
    });

    // 2. Subsequent normal tap completes with zero remaining native touches.
    const tapTouch = makeTouch(1, 2);
    dispatchEvent(inputFiber, "topTouchStart", {
      touches: [tapTouch],
      changedTouches: [tapTouch],
    });
    dispatchEvent(inputFiber, "topTouchEnd", {
      touches: [],
      changedTouches: [tapTouch],
    });

    // 3. Typing triggers topSelectionChange. With trackedTouchCount reconciled to 0,
    //    the input must not claim responder and swallow the next tap on a sibling button.
    dispatchEvent(inputFiber, "topSelectionChange", {
      selection: { start: 1, end: 1 },
    });
    assert.equal(
      inputGrants,
      0,
      "topSelectionChange must not claim responder when no touches are active",
    );

    // 4. First tap on sibling send button must be granted immediately.
    const sendTouch = makeTouch(2, 3);
    dispatchEvent(buttonFiber, "topTouchStart", {
      touches: [sendTouch],
      changedTouches: [sendTouch],
    });
    dispatchEvent(buttonFiber, "topTouchEnd", {
      touches: [],
      changedTouches: [sendTouch],
    });
    assert.equal(buttonGrants, 1, "first tap on sibling button must receive responder grant");

    // 5. Two-finger gesture cancelled by a single synthetic topTouchCancel (e.g. RNGH pinch takeover)
    //    must reconcile trackedTouchCount to 0 and mark every touchBank contact inactive before
    //    onResponderTerminate runs.
    let terminatedHistory = null;
    const gestureFiber = createHostFiber(
      "RCTView",
      {
        onStartShouldSetResponder: () => true,
        onResponderTerminate: (event) => {
          terminatedHistory = {
            numberActiveTouches: event.touchHistory.numberActiveTouches,
            activeBankIds: Array.from(event.touchHistory.touchBank, (record, index) =>
              record?.touchActive ? index : -1,
            ).filter((index) => index >= 0),
          };
        },
      },
      rootFiber,
    );
    const p0 = makeTouch(3, 4);
    const p1 = makeTouch(4, 5);
    dispatchEvent(gestureFiber, "topTouchStart", { touches: [p0], changedTouches: [p0] });
    dispatchEvent(gestureFiber, "topTouchStart", { touches: [p0, p1], changedTouches: [p1] });
    dispatchEvent(gestureFiber, "topTouchCancel", { touches: [], changedTouches: [p0] });
    assert.deepEqual(terminatedHistory, {
      numberActiveTouches: 0,
      activeBankIds: [],
    });
    dispatchEvent(inputFiber, "topSelectionChange", { selection: { start: 2, end: 2 } });
    assert.equal(
      inputGrants,
      0,
      "single topTouchCancel after 2-finger touch must reset trackedTouchCount to 0",
    );

    // 6. Multi-touch cancel emitting two topTouchCancel events with touches: [] must stay at 0 without warning.
    const t0 = makeTouch(5, 6);
    const t1 = makeTouch(6, 7);
    dispatchEvent(rootFiber, "topTouchStart", { touches: [t0], changedTouches: [t0] });
    dispatchEvent(rootFiber, "topTouchStart", { touches: [t0, t1], changedTouches: [t1] });
    dispatchEvent(rootFiber, "topTouchCancel", { touches: [], changedTouches: [t0, t1] });
    dispatchEvent(rootFiber, "topTouchCancel", { touches: [], changedTouches: [t0, t1] });
    dispatchEvent(inputFiber, "topSelectionChange", { selection: { start: 3, end: 3 } });
    assert.equal(inputGrants, 0, "multi-touch cancel must leave trackedTouchCount at 0");
    assert.deepEqual(
      warnings.filter((w) => w.includes("trackedTouchCount")),
      [],
    );
  });
}

test("patched @mattermost/react-native-paste-input Android PasteTextInput does not claim responder on selection change", () => {
  for (const relPath of [
    "node_modules/@mattermost/react-native-paste-input/src/PasteTextInput.tsx",
    "node_modules/@mattermost/react-native-paste-input/lib/commonjs/PasteTextInput.js",
    "node_modules/@mattermost/react-native-paste-input/lib/module/PasteTextInput.js",
  ]) {
    const source = readFileSync(path.resolve(relPath), "utf8");
    assert.equal(
      source.includes("onSelectionChangeShouldSetResponder"),
      false,
      `${relPath} must not set onSelectionChangeShouldSetResponder (matches RN AndroidTextInput)`,
    );
  }
});
