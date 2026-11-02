/**
 * `desktop/desktop.json` — the one declarative file that describes a desktop
 * app: its name, identifier, version, icon, window, and how it is packaged.
 *
 * The model is Tauri's `tauri.conf.json`: the app owns the file, it is data
 * rather than code, and it ships a JSON schema so editors can complete it.
 * `react-native.config.js` keeps only build-tooling options, because it is
 * executable JavaScript that nothing can read statically.
 *
 * Every field is optional. An app with no `desktop.json` still runs and packages
 * with the defaults below.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The alpha formats each OS can produce. `all` expands to these. */
export const TARGETS_BY_OS = {
  macos: ['app', 'dmg'],
  windows: ['nsis'],
  linux: ['deb', 'appimage'],
};

/** Every format this phase can produce, on any OS. */
export const ALL_TARGETS = ['app', 'dmg', 'nsis', 'deb', 'appimage'];

/**
 * The OS name this module's files and targets use, from a Node platform.
 *
 * `desktop.macos.json` rather than `desktop.darwin.json`: the file names the
 * platform a person would, and `process.platform` uses Node's spelling.
 */
export function desktopOs(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return platform;
  }
}

/**
 * The key names that must never appear in a config file.
 *
 * Signing material comes from the environment (D6). A password, token or
 * private key written into a file that gets committed and shipped is a leak
 * whether or not it is still valid, so a config carrying one is refused rather
 * than warned about.
 */
const SECRET_KEY = /password|secret|token|privateKey/iu;

export const DEFAULT_WINDOW = { width: 1024, height: 768 };
export const DEFAULT_MACOS_MINIMUM = '13.0';

/**
 * RFC 7386 JSON Merge Patch.
 *
 * A `null` in `patch` removes the key, which is how a per-OS file turns off a
 * value the base set: `{"bundle": {"macos": null}}`. Arrays and scalars replace
 * wholesale; only objects merge.
 */
export function mergePatch(target, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const base =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? target
      : {};
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(base[key], value);
    }
  }
  return result;
}

/** `com.example.my-app`, from an app name. */
export function identifierFromName(name) {
  return `com.example.${String(name)
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, '-')}`;
}

/**
 * The `desktop.json` path for an app.
 *
 * It lives in the app's existing `desktop/` folder, beside the Rust crate it
 * configures.
 */
export function desktopConfigPath(projectRoot) {
  return path.join(projectRoot, 'desktop', 'desktop.json');
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${file}\n${error.message}`);
  }
}

/**
 * Loads the configuration for one OS.
 *
 * Reads `desktop/desktop.json`, merges `desktop/desktop.<os>.json` over it,
 * fills the defaults, validates, and refuses a config carrying a secret. Pure
 * apart from those reads.
 */
export function loadDesktopConfig(projectRoot, platform) {
  const os = desktopOs(platform);
  const basePath = path.join(projectRoot, 'desktop', 'desktop.json');
  const osPath = path.join(projectRoot, 'desktop', `desktop.${os}.json`);
  const appConfigPath = path.join(projectRoot, 'app.json');
  const packageJsonPath = path.join(projectRoot, 'package.json');

  const base = readJson(basePath, 'desktop/desktop.json');
  if (base !== undefined) assertObject(base, 'desktop/desktop.json', '$');
  const override = readJson(osPath, `desktop/desktop.${os}.json`);
  if (override !== undefined) {
    assertObject(override, `desktop/desktop.${os}.json`, '$');
  }

  // The key that used to hold these options. It is rejected rather than read:
  // the option would be ignored, and the app would silently get a default.
  const appConfig = readJson(appConfigPath, 'app.json') ?? {};
  if (
    appConfig.desktop !== undefined &&
    appConfig.desktop !== null &&
    typeof appConfig.desktop === 'object' &&
    Object.keys(appConfig.desktop).length > 0
  ) {
    throw new Error(
      'move `app.json` desktop.* into `desktop/desktop.json` (see the README)',
    );
  }

  const merged =
    base === undefined && override === undefined
      ? {}
      : mergePatch(base ?? {}, override ?? {});

  // Secrets first: the schema rejects unknown keys, and "unknown key" is a
  // misleading way to describe a password someone tried to commit.
  assertNoSecrets(merged, '$');

  const errors = [];
  validateAgainst(merged, SCHEMA, '$', errors);
  if (errors.length > 0) {
    throw new Error(
      `invalid desktop/desktop.json:\n${errors.map(error => `  ${error}`).join('\n')}`,
    );
  }

  const packageJson = readJson(packageJsonPath, 'package.json') ?? {};
  return withDefaults(merged, { appConfig, packageJson });
}

function assertObject(value, label, jsonPath) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}: ${jsonPath} must be an object`);
  }
}

/**
 * Fills every field an app may omit.
 *
 * `window.title` defaults to `productName` rather than the app name, so a
 * title bar and the app's own name are the same string unless asked otherwise.
 */
function withDefaults(config, { appConfig, packageJson }) {
  const productName =
    config.productName ??
    appConfig.displayName ??
    appConfig.name ??
    packageJson.name ??
    'App';
  const identifier =
    config.identifier ?? identifierFromName(appConfig.name ?? productName);
  const version = config.version ?? packageJson.version ?? '1.0.0';
  const window = { ...DEFAULT_WINDOW, ...(config.window ?? {}) };
  if (window.title === undefined) window.title = productName;
  if (window.resizable === undefined) window.resizable = true;
  if (window.restoreState === undefined) window.restoreState = true;

  const tray =
    config.tray === undefined ? undefined : { accessory: true, ...config.tray };

  const bundle = { ...(config.bundle ?? {}) };
  if (bundle.targets === undefined) bundle.targets = 'all';
  if (bundle.resources === undefined) bundle.resources = [];
  bundle.macos = {
    minimumSystemVersion: DEFAULT_MACOS_MINIMUM,
    ...(bundle.macos ?? {}),
  };
  if (bundle.macos.entitlements === undefined) bundle.macos.entitlements = null;
  if (bundle.macos.infoPlist === undefined) bundle.macos.infoPlist = {};
  bundle.windows = bundle.windows ?? {};
  bundle.windows.nsis = {
    installMode: 'currentUser',
    ...(bundle.windows.nsis ?? {}),
  };
  bundle.linux = bundle.linux ?? {};
  bundle.linux.deb = { depends: [], ...(bundle.linux.deb ?? {}) };
  bundle.linux.appimage = bundle.linux.appimage ?? {};

  return {
    productName,
    identifier,
    version,
    ...(config.icon === undefined ? {} : { icon: config.icon }),
    window,
    devMenu: config.devMenu ?? true,
    ...(tray === undefined ? {} : { tray }),
    bundle,
  };
}

/** The formats to build for one OS. */
export function targetsFor(config, platform) {
  const os = desktopOs(platform);
  const available = TARGETS_BY_OS[os] ?? [];
  const requested = config.bundle?.targets ?? 'all';
  const list = requested === 'all' ? available : requested;
  const unknown = list.filter(target => !ALL_TARGETS.includes(target));
  if (unknown.length > 0) {
    throw new Error(
      `unknown bundle target(s) ${unknown.join(', ')}; expected one of ${ALL_TARGETS.join(', ')} or 'all'`,
    );
  }
  const unavailable = list.filter(target => !available.includes(target));
  if (unavailable.length > 0) {
    throw new Error(
      `${unavailable.join(', ')} cannot be built on ${os}; available targets are ${available.join(', ')}`,
    );
  }
  return list;
}

/**
 * Walks the merged config and refuses any key that names signing material.
 *
 * The values are not quoted in the error: printing a leaked secret into a build
 * log is the same mistake twice.
 */
function assertNoSecrets(value, jsonPath) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecrets(item, `${jsonPath}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(
        `desktop/desktop.json must not contain signing material: ${jsonPath}.${key}. ` +
          'Set it in the environment instead; see the README.',
      );
    }
    assertNoSecrets(child, `${jsonPath}.${key}`);
  }
}

/**
 * Validates against `desktop.schema.json`.
 *
 * A small validator for exactly this schema, because the CLI ships with no
 * dependencies and the plan asks before adding one. It reports the JSON path of
 * the first problem at each location rather than only the first overall: a
 * config with two typos should not need two runs to fix.
 *
 * The schema subset it implements is `type`, `enum`, `pattern`, `minLength`,
 * `exclusiveMinimum`, `required`, `properties`, `additionalProperties`,
 * `items`, `minItems`, `oneOf`.
 */
function typeMatches(value, type) {
  switch (type) {
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateAgainst(value, schema, jsonPath, errors) {
  const types =
    schema.type === undefined
      ? undefined
      : Array.isArray(schema.type)
        ? schema.type
        : [schema.type];
  if (types !== undefined && !types.some(type => typeMatches(value, type))) {
    errors.push(`${jsonPath}: expected ${types.join(' or ')}`);
    return;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(
      `${jsonPath}: expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`,
    );
    return;
  }
  if (schema.pattern !== undefined && typeof value === 'string') {
    if (!new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${jsonPath}: does not match ${schema.pattern}`);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string') {
    if (value.length < schema.minLength) {
      errors.push(`${jsonPath}: must not be empty`);
    }
  }
  if (schema.exclusiveMinimum !== undefined && typeof value === 'number') {
    if (value <= schema.exclusiveMinimum) {
      errors.push(
        `${jsonPath}: must be greater than ${schema.exclusiveMinimum}`,
      );
    }
  }

  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter(branch => {
      const branchErrors = [];
      validateAgainst(value, branch, jsonPath, branchErrors);
      return branchErrors.length === 0;
    });
    if (matched.length !== 1) {
      errors.push(
        `${jsonPath}: matches ${matched.length} of ${schema.oneOf.length} allowed shapes, expected exactly one`,
      );
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${jsonPath}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        validateAgainst(item, schema.items, `${jsonPath}[${index}]`, errors),
      );
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) {
        errors.push(`${jsonPath}: missing required key ${required}`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${jsonPath}.${key}`;
      if (properties[key] !== undefined) {
        validateAgainst(child, properties[key], childPath, errors);
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties).sort().join(', ');
        errors.push(`${childPath}: unknown key; known keys are ${known}`);
      }
    }
  }
}

/** The schema, read once. `desktop.schema.json` is shipped and documented. */
const SCHEMA = JSON.parse(
  fs.readFileSync(new URL('../desktop.schema.json', import.meta.url), 'utf8'),
);

/** The schema itself, for `--print-schema` and for callers that ship it. */
export function desktopSchema() {
  return SCHEMA;
}
