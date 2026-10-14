import { writeFileSync } from "node:fs";
const commit = process.env.PASEO_LOCAL_RELEASE_COMMIT;
if (!commit || !/^[a-f0-9]{40}$/.test(commit))
  throw new Error("Use npm run build:desktop:local from the repository root.");
writeFileSync(new URL("../dist/local-build.json", import.meta.url), JSON.stringify({ commit }));
