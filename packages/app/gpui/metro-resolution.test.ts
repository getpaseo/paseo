import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const GPUI_DIR = import.meta.dirname;
const APP_DIR = path.resolve(GPUI_DIR, "..");

interface MetroConfig {
  resolver: {
    sourceExts: string[];
    resolveRequest: (
      context: Record<string, unknown>,
      moduleName: string,
      platform: string | null,
    ) => { type: string; filePath?: string };
  };
}

function createResolutionContext(
  originModulePath: string,
  sourceExts: string[],
  preferNativePlatform: boolean,
  resolverModule: { resolve: (...args: unknown[]) => unknown },
) {
  const fileSystemLookup = (candidatePath: string) => {
    try {
      const stats = statSync(candidatePath);
      if (stats.isFile() || stats.isDirectory()) {
        return {
          exists: true,
          type: stats.isFile() ? "f" : "d",
          realPath: realpathSync(candidatePath),
        };
      }
    } catch {
      // Missing candidate path.
    }
    return { exists: false };
  };

  return {
    allowHaste: false,
    assetExts: new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]),
    customResolverOptions: {},
    dev: false,
    disableHierarchicalLookup: false,
    doesFileExist: (filePath: string) => fileSystemLookup(filePath).exists,
    extraNodeModules: {},
    fileSystemLookup,
    getPackage: () => null,
    getPackageForModule: () => null,
    mainFields: ["react-native", "browser", "main"],
    nodeModulesPaths: [path.join(GPUI_DIR, "node_modules"), path.join(APP_DIR, "node_modules")],
    originModulePath,
    preferNativePlatform,
    redirectModulePath: (modulePath: string) => modulePath,
    resolveAsset: () => null,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    resolveRequest: resolverModule.resolve,
    sourceExts,
    unstable_conditionNames: ["require", "react-native"],
    unstable_conditionsByPlatform: {},
    unstable_enablePackageExports: false,
    unstable_incrementalResolution: false,
    unstable_logWarning: () => {},
  };
}

function loadAppMetroConfig(webPlatform?: string) {
  const previous = process.env.PASEO_WEB_PLATFORM;
  if (webPlatform === undefined) delete process.env.PASEO_WEB_PLATFORM;
  else process.env.PASEO_WEB_PLATFORM = webPlatform;

  const configPath = path.join(APP_DIR, "metro.config.cjs");
  delete require.cache[configPath];
  try {
    return {
      config: require(configPath) as MetroConfig,
      resolver: require(
        require.resolve("metro-resolver", { paths: [APP_DIR, path.resolve(APP_DIR, "../..")] }),
      ) as { resolve: (...args: unknown[]) => unknown },
    };
  } finally {
    if (previous === undefined) delete process.env.PASEO_WEB_PLATFORM;
    else process.env.PASEO_WEB_PLATFORM = previous;
  }
}

const CASES = [
  {
    label: "audio engine",
    origin: path.join(APP_DIR, "src/audio/index.ts"),
    specifier: "./audio-engine",
    gpui: path.join(APP_DIR, "src/audio/audio-engine.gpui.ts"),
    native: path.join(APP_DIR, "src/audio/audio-engine.native.ts"),
    web: path.join(APP_DIR, "src/audio/audio-engine.web.ts"),
  },
  {
    label: "mermaid fence host",
    origin: path.join(APP_DIR, "src/components/markdown/fence/mermaid/index.tsx"),
    specifier: "./host",
    gpui: path.join(APP_DIR, "src/components/markdown/fence/mermaid/host.gpui.tsx"),
    native: path.join(APP_DIR, "src/components/markdown/fence/mermaid/host.native.tsx"),
    web: path.join(APP_DIR, "src/components/markdown/fence/mermaid/host.web.tsx"),
  },
  {
    label: "html preview",
    origin: path.join(APP_DIR, "src/file-panels/builtin.tsx"),
    specifier: "./html-preview",
    gpui: path.join(APP_DIR, "src/file-panels/html-preview.gpui.tsx"),
    native: path.join(APP_DIR, "src/file-panels/html-preview.tsx"),
    web: path.join(APP_DIR, "src/file-panels/html-preview.web.tsx"),
  },
  {
    label: "document frame",
    origin: path.join(APP_DIR, "src/plugins/react-native/ui.ts"),
    specifier: "@/file-panels/document-frame",
    gpui: path.join(APP_DIR, "src/file-panels/document-frame/index.gpui.tsx"),
    native: path.join(APP_DIR, "src/file-panels/document-frame/index.tsx"),
    web: path.join(APP_DIR, "src/file-panels/document-frame/index.web.tsx"),
  },
  {
    label: "press feedback",
    origin: path.join(APP_DIR, "modules/paseo-press-feedback/src/ui/index.tsx"),
    specifier: "./feedback",
    gpui: path.join(APP_DIR, "modules/paseo-press-feedback/src/ui/feedback.gpui.tsx"),
    native: path.join(APP_DIR, "modules/paseo-press-feedback/src/ui/feedback.native.tsx"),
    web: path.join(APP_DIR, "modules/paseo-press-feedback/src/ui/feedback.tsx"),
  },
  {
    label: "pointer capabilities",
    origin: path.join(APP_DIR, "src/components/ui/control-sizing.ts"),
    specifier: "@/hooks/pointer-capabilities",
    gpui: path.join(APP_DIR, "src/hooks/pointer-capabilities.gpui.ts"),
    native: path.join(APP_DIR, "src/hooks/pointer-capabilities.ts"),
    web: path.join(APP_DIR, "src/hooks/pointer-capabilities.ts"),
  },
];

afterEach(() => {
  delete require.cache[path.join(APP_DIR, "metro.config.cjs")];
});

describe("GPUI Metro platform rule", () => {
  test("GPUI resolves .gpui.* files ahead of .desktop, .native, and base files", () => {
    const config = require(path.join(GPUI_DIR, "desktop/metro.config.js")) as MetroConfig;
    const resolver = require(require.resolve("metro-resolver", { paths: [GPUI_DIR] })) as {
      resolve: (...args: unknown[]) => unknown;
    };

    for (const item of CASES) {
      const ctx = createResolutionContext(item.origin, config.resolver.sourceExts, true, resolver);
      expect(
        config.resolver.resolveRequest(ctx, item.specifier, "desktop").filePath,
        item.label,
      ).toBe(item.gpui);
    }

    // GPUI must not pick Electron's .electron.* files as "desktop".
    const browserCtx = createResolutionContext(
      path.join(APP_DIR, "src/components/split-container.tsx"),
      config.resolver.sourceExts,
      true,
      resolver,
    );
    expect(
      config.resolver.resolveRequest(browserCtx, "@/desktop/browser/pane", "desktop").filePath,
    ).toBe(path.join(APP_DIR, "src/desktop/browser/pane/index.tsx"));
  });

  test("iOS, Android, web, and Electron never resolve .gpui.* files", () => {
    const relativeCases = CASES.filter((item) => !item.specifier.startsWith("@/"));
    const standard = loadAppMetroConfig();
    const electron = loadAppMetroConfig("electron");
    const targets = [
      { ...standard, platform: "ios", preferNative: true, expected: "native" as const },
      { ...standard, platform: "android", preferNative: true, expected: "native" as const },
      { ...standard, platform: "web", preferNative: false, expected: "web" as const },
      { ...electron, platform: "web", preferNative: false, expected: "web" as const },
    ];

    for (const target of targets) {
      for (const item of relativeCases) {
        const ctx = createResolutionContext(
          item.origin,
          target.config.resolver.sourceExts,
          target.preferNative,
          target.resolver,
        );
        const filePath = target.config.resolver.resolveRequest(
          ctx,
          item.specifier,
          target.platform,
        ).filePath;
        expect(filePath, `${target.platform}: ${item.label}`).toBe(item[target.expected]);
        expect(filePath).not.toContain(".gpui.");
      }
    }
  });
});
