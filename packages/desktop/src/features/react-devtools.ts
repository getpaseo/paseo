import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { app, session, net } from "electron";

const REACT_DEVTOOLS_EXTENSION_ID = "fmkadmapgofadopljbjfkapdkoienihi";

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
    const ext = await session.defaultSession.extensions.loadExtension(extensionPath, {
      allowFileAccess: true,
    });
    console.log(`[DevTools] Loaded: ${ext.name}`);
  } catch (err) {
    console.warn("[DevTools] Failed to load React DevTools:", err);
  }
}
