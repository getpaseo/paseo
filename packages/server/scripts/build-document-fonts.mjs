import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ensureDocumentFonts } from "./ensure-document-fonts.mjs";

const source = new URL("../assets/document-fonts/", import.meta.url);
await ensureDocumentFonts(source);
if (process.platform === "darwin") {
  const result = spawnSync(
    "xcrun",
    [
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=13.0",
      "-O2",
      "-framework",
      "CoreFoundation",
      "-framework",
      "CoreText",
      fileURLToPath(new URL("register-fonts.c", source)),
      "-o",
      fileURLToPath(new URL("register-fonts", source)),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
cpSync(source, new URL("../dist/assets/document-fonts/", import.meta.url), { recursive: true });
