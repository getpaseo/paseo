import electron from "electron";
import { smokePackagedDesktopApp } from "../e2e/packaged-app-smoke.js";
import { extractFile } from "@electron/asar";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function verifyLocalRelease(source, commit) {
  const resources = path.join(source, "Contents/Resources");
  const archive = path.join(resources, "app.asar");
  const metadata = JSON.parse(extractFile(archive, "dist/local-build.json").toString());
  if (!/^[a-f0-9]{40}$/.test(commit ?? "") || metadata.commit !== commit)
    throw new Error("Local build identity mismatch");
  const web = path.join(resources, "app-dist/_expo/static/js/web");
  const scripts = await readdir(web);
  const bundles = await Promise.all(
    scripts.filter((f) => f.endsWith(".js")).map((f) => readFile(path.join(web, f), "utf8")),
  );
  if (
    !bundles.some((code) => code.includes(commit) && code.includes("sidebar-project-menu-hide-"))
  ) {
    throw new Error("Packaged renderer is missing the release identity or Hide project action");
  }
  const harness = fileURLToPath(new URL("../e2e/local-release-widget.cjs", import.meta.url));
  const result = spawnSync(electron, [harness, archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error(
      `Packaged pop-up verification failed: ${result.stderr || result.stdout || result.error}`,
    );
  await smokePackagedDesktopApp({ appPath: source, verifyLocalRelease: true });
  await writeFile(path.join(resources, "local-release.json"), JSON.stringify({ commit }));
  return { commit };
}
