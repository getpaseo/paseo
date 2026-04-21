import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { app, session, net } from "electron";

const REACT_DEVTOOLS_EXTENSION_ID = "fmkadmapgofadopljbjfkapdkoienihi";

type ReactDevToolsContentScript = {
  matches: string[];
  js: string[];
  run_at: "document_start" | "document_end";
  world?: "MAIN";
};

type ReactDevToolsManifest = {
  version?: string;
  manifest_version?: number;
  content_scripts?: ReactDevToolsContentScript[];
};

const ELECTRON_COMPATIBLE_CONTENT_SCRIPTS: ReactDevToolsContentScript[] = [
  {
    matches: ["<all_urls>"],
    js: ["build/proxy.js"],
    run_at: "document_start",
  },
  {
    matches: ["<all_urls>"],
    js: ["build/installHook.js"],
    run_at: "document_start",
    world: "MAIN",
  },
  {
    matches: ["<all_urls>"],
    js: ["build/hookSettingsInjector.js"],
    run_at: "document_start",
  },
  {
    matches: ["<all_urls>"],
    js: ["build/fileFetcher.js"],
    run_at: "document_end",
  },
];

function hasStaticReactHookScript(manifest: ReactDevToolsManifest): boolean {
  return (
    manifest.content_scripts?.some((script) => script.js.includes("build/installHook.js")) ?? false
  );
}

async function patchReactDevToolsForElectron(extensionPath: string): Promise<void> {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as ReactDevToolsManifest;

  if (manifest.manifest_version !== 3 || hasStaticReactHookScript(manifest)) {
    return;
  }

  // React DevTools v7 relies on chrome.scripting.registerContentScripts,
  // which Electron does not reliably inject into app pages. Static scripts do.
  manifest.content_scripts = ELECTRON_COMPATIBLE_CONTENT_SCRIPTS;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[DevTools] Patched React DevTools ${manifest.version} content scripts for Electron`);
}

export async function loadReactDevTools(): Promise<void> {
  const extensionsDir = path.join(app.getPath("userData"), "extensions");
  const extensionPath = path.join(extensionsDir, REACT_DEVTOOLS_EXTENSION_ID);

  if (!existsSync(extensionPath)) {
    await mkdir(extensionsDir, { recursive: true });
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&x=id%3D${REACT_DEVTOOLS_EXTENSION_ID}%26uc&prodversion=${process.versions.chrome}`;
    const crxPath = `${extensionPath}.crx`;

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const request = net.request(crxUrl);
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });

    await writeFile(crxPath, buffer);
    const unzipCrx = (await import("unzip-crx-3")).default;
    await unzipCrx(crxPath, extensionPath);
    await unlink(crxPath);
  }

  try {
    await patchReactDevToolsForElectron(extensionPath);
    const ext = await session.defaultSession.extensions.loadExtension(extensionPath, {
      allowFileAccess: true,
    });
    console.log(`[DevTools] Loaded: ${ext.name}`);
  } catch (err) {
    console.warn("[DevTools] Failed to load React DevTools:", err);
  }
}
