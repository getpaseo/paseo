import { appTasks } from "@ohos/hvigor-ohos-plugin";

/**
 * Paseo HarmonyOS — project-level hvigor configuration.
 *
 * Before building, run the npm→oh_modules bridge script to set up
 * type-only declaration views of npm workspace packages:
 *
 *   node scripts/setup-oh-modules.mjs
 *
 * This generates dist-types/ directories and oh_modules/ symlinks
 * so the ArkTS compiler can resolve @getpaseo/* imports without
 * encountering .js files (which OhmUrl cannot process).
 */

export default {
  system: appTasks,
  plugins: [],
};
