import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.url === \`file://${process.argv[1]}\`` is false on Windows, where argv[1] is
// `D:\a\...` and the module URL is `file:///D:/a/...`, so a script guarded that way silently
// does nothing on a Windows runner. Compare resolved filesystem paths instead.
export function isMainModule(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return fileURLToPath(importMetaUrl) === path.resolve(argvPath);
}
