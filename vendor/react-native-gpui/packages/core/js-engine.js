const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = ['desktop', 'autolink', 'autolink.json'];

function installedJsEngines(projectRoot) {
  const manifestPath = path.join(projectRoot, ...MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest.jsEngines) ? manifest.jsEngines : [];
  } catch {
    return [];
  }
}

/**
 * The engine this run uses, mirroring the runtime's selection: the
 * `RN_GPUI_JS_ENGINE` override, otherwise the only installed engine. Returns
 * null when the choice is ambiguous or nothing is installed, in which case the
 * runtime reports it.
 */
function activeJsEngine(projectRoot) {
  const engines = installedJsEngines(projectRoot);
  const requested = process.env.RN_GPUI_JS_ENGINE;
  if (requested) {
    return engines.find(engine => engine.name === requested) ?? null;
  }
  return engines.length === 1 ? engines[0] : null;
}

function activeJsEngineBundle(projectRoot) {
  const engine = activeJsEngine(projectRoot);
  if (!engine || !engine.bundle) return null;
  // Absolute path: the manifest records where the package actually lives, which
  // may be a hoisted or linked install rather than the app's own node_modules.
  return require(engine.bundle);
}

function activeJsEngineBundleExtension(projectRoot) {
  const bundle = activeJsEngineBundle(projectRoot);
  return typeof bundle?.bundleExtension === 'string'
    ? bundle.bundleExtension
    : '.js';
}

module.exports = {
  installedJsEngines,
  activeJsEngine,
  activeJsEngineBundle,
  activeJsEngineBundleExtension,
};
