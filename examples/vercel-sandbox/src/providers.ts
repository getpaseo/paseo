import type { SessionState } from "./types.js";

export type ProviderId = "codex" | "claude" | "opencode" | "pi" | "copilot";

export interface ProviderDefinition {
  id: ProviderId;
  package: string;
  version: string;
  binary: string;
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  codex: {
    id: "codex",
    package: "@openai/codex",
    version: "0.154.0",
    binary: "codex",
    defaultModel: "openai/gpt-6-astra",
  },
  claude: {
    id: "claude",
    package: "@anthropic-ai/claude-code",
    version: "2.1.273",
    binary: "claude",
    defaultModel: "anthropic/claude-sonnet-5",
  },
  opencode: {
    id: "opencode",
    package: "opencode-ai",
    version: "1.18.31",
    binary: "opencode",
    defaultModel: "anthropic/claude-sonnet-5",
  },
  pi: {
    id: "pi",
    package: "@earendil-works/pi-coding-agent",
    version: "0.85.1",
    binary: "pi",
    defaultModel: "anthropic/claude-sonnet-5",
  },
  copilot: {
    id: "copilot",
    package: "@github/copilot",
    version: "1.0.83",
    binary: "copilot",
    defaultModel: "openai/gpt-6-astra",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function resolveProvider(value: string): ProviderDefinition {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, value)) {
    throw new Error(
      `unsupported agent provider '${value}'; expected one of ${PROVIDER_IDS.join(", ")}`,
    );
  }
  return PROVIDERS[value as ProviderId];
}

export function validateProviderSelection(provider: string, model: string): ProviderDefinition {
  const definition = resolveProvider(provider);
  if (!model.trim() || !/^[^/]+\/.+[^/]$/.test(model)) {
    throw new Error(
      `agent model for ${definition.id} must be a slash-qualified Gateway model ID (for example ${definition.defaultModel})`,
    );
  }
  return definition;
}

export function providerEnvironment(agentKey: string): Record<string, string> {
  return {
    AI_GATEWAY_API_KEY: agentKey,
    ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code",
    ANTHROPIC_AUTH_TOKEN: agentKey,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    COPILOT_PROVIDER_BASE_URL: "https://ai-gateway.vercel.sh/coding-agent/v1",
    COPILOT_PROVIDER_API_KEY: agentKey,
  };
}

export function providerLaunchEnvironment(agentKey: string, model: string): Record<string, string> {
  return { ...providerEnvironment(agentKey), COPILOT_MODEL: model };
}

const SENSITIVE_FIELD =
  /(api[_-]?key|auth[_-]?token|token|secret|password|authorization|credential|pairing|offer|daemonpublickeyb64|relaykey)/i;

function redactValue(value: string, agentKey: string | undefined): string {
  let result = value;
  if (agentKey) result = result.replaceAll(agentKey, "[REDACTED]");
  return result
    .replace(/https:\/\/app\.paseo\.sh\/#offer=\S+/gi, "[REDACTED]")
    .replace(/paseo:\/\/\S+/gi, "paseo://[REDACTED]")
    .replace(/(Bearer\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)[^\s"',}]+/gi, "$1[REDACTED]");
}

export function redactDiagnostic(
  value: unknown,
  agentKey = process.env.AI_GATEWAY_API_KEY,
): unknown {
  if (typeof value === "string") return redactValue(value, agentKey);
  if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item, agentKey));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactDiagnostic(item, agentKey);
  }
  return result;
}

export function redactText(value: string, agentKey = process.env.AI_GATEWAY_API_KEY): string {
  return redactValue(value, agentKey);
}

export function providerConfigScript(state: SessionState): string {
  validateProviderSelection(state.agentProvider, state.agentModel);
  const copilotModel =
    state.agentProvider === "copilot" ? state.agentModel : PROVIDERS.copilot.defaultModel;
  const codexModel =
    state.agentProvider === "codex" ? state.agentModel : PROVIDERS.codex.defaultModel;
  const claudeModel =
    state.agentProvider === "claude" ? state.agentModel : PROVIDERS.claude.defaultModel;

  return `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const agentKey = process.env.AI_GATEWAY_API_KEY;
if (!agentKey) throw new Error('AI_GATEWAY_API_KEY is required');
if (process.env.OPENCODE_AUTH_CONTENT) {
  throw new Error('OPENCODE_AUTH_CONTENT conflicts with the managed OpenCode auth file');
}

const home = fs.realpathSync(os.homedir());
const homeReal = fs.realpathSync(home);
function checkDirectory(directory, create = false) {
  const parent = path.dirname(directory);
  if (parent !== directory) checkDirectory(parent, create);
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) {
    if (create) fs.mkdirSync(directory, { mode: 0o700 });
    else throw new Error('configuration directory is missing');
  } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('configuration path is not a directory');
  }
}
function ensureDirectory(directory, allowOutsideHome = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('configuration directory must be absolute');
  const normalized = path.resolve(directory);
  if (!allowOutsideHome && normalized !== homeReal && !normalized.startsWith(homeReal + path.sep)) {
    throw new Error('configuration path escapes the sandbox home');
  }
  checkDirectory(normalized, true);
  return normalized;
}
function managedDirectory(environmentName, fallback) {
  const override = process.env[environmentName];
  if (override !== undefined && override !== '' && !path.isAbsolute(override)) {
    throw new Error(environmentName + ' must be an absolute directory inside the sandbox home');
  }
  return ensureDirectory(override && override !== '' ? override : path.join(homeReal, ...fallback));
}
function readRegularFile(file) {
  checkDirectory(path.dirname(file));
  const stats = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('configuration path is not a regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
const preimages = new Map();
const digest = (bytes) => bytes === null ? 'MISSING' : crypto.createHash('sha256').update(bytes).digest('hex');
function readConfiguration(file) {
  const bytes = readRegularFile(file);
  preimages.set(file, digest(bytes));
  return bytes === null ? null : bytes.toString('utf8');
}
function assertUnchanged(file) {
  if (digest(readRegularFile(file)) !== preimages.get(file)) throw new Error('STALE_PRECONDITION: configuration changed');
}
function atomicReplace(file, contents) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function atomicWrite(file, contents, receiptDirectory) {
  assertUnchanged(file);
  atomicReplace(file, contents);
  const receipt = {
    target: file, actor: 'configure-providers', timestamp: new Date().toISOString(),
    pre_edit_sha256: preimages.get(file), post_edit_sha256: digest(Buffer.from(contents)), result: 'WRITE_COMMITTED',
  };
  atomicReplace(path.join(receiptDirectory, crypto.randomUUID() + '.json'), JSON.stringify(receipt) + '\\n');
}
function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}
function objectField(object, key) {
  if (!Object.hasOwn(object, key)) object[key] = {};
  return requireObject(object[key], key);
}
function validateEnv(env) {
  requireObject(env, 'provider env');
  if (Object.values(env).some((value) => typeof value !== 'string')) throw new Error('provider env values must be strings');
}
function validateModels(models) {
  if (!Array.isArray(models)) throw new Error('provider models must be an array');
  for (const model of models) {
    requireObject(model, 'provider model');
    if (typeof model.id !== 'string' || !model.id || typeof model.label !== 'string' || !model.label) throw new Error('provider model requires id and label');
    if (model.description !== undefined && typeof model.description !== 'string') throw new Error('invalid model description');
    if (model.isDefault !== undefined && typeof model.isDefault !== 'boolean') throw new Error('invalid model default');
    if (model.thinkingOptions !== undefined) {
      if (!Array.isArray(model.thinkingOptions)) throw new Error('invalid thinking options');
      for (const option of model.thinkingOptions) {
        requireObject(option, 'thinking option');
        if (typeof option.id !== 'string' || typeof option.label !== 'string' ||
            (option.description !== undefined && typeof option.description !== 'string') ||
            (option.isDefault !== undefined && typeof option.isDefault !== 'boolean')) throw new Error('invalid thinking option');
      }
    }
  }
}
function readJsonObject(file) {
  const text = readConfiguration(file);
  if (text === null) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('malformed JSON configuration'); }
  return requireObject(parsed, 'JSON configuration');
}
function serializeJson(file, value) {
  return [file, JSON.stringify(value, null, 2) + '\\n'];
}

const claudeDir = managedDirectory('CLAUDE_CONFIG_DIR', ['.claude']);
const claudePath = path.join(claudeDir, 'settings.json');
const claude = readJsonObject(claudePath);
const claudeEnv = objectField(claude, 'env');
validateEnv(claudeEnv);
claude.model = ${JSON.stringify(claudeModel)};
claude.env = {
  ...claudeEnv,
  ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh/claude-code',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  ANTHROPIC_MODEL: ${JSON.stringify(claudeModel)},
  ANTHROPIC_SMALL_FAST_MODEL: ${JSON.stringify(claudeModel)},
  ANTHROPIC_DEFAULT_OPUS_MODEL: ${JSON.stringify(claudeModel)},
  ANTHROPIC_DEFAULT_SONNET_MODEL: ${JSON.stringify(claudeModel)},
  ANTHROPIC_DEFAULT_HAIKU_MODEL: ${JSON.stringify(claudeModel)},
};

const openCodeConfigDir = managedDirectory('OPENCODE_CONFIG_DIR', ['.config', 'opencode']);
const openCodeConfigPath = path.join(openCodeConfigDir, 'opencode.json');
const openCodeConfig = readJsonObject(openCodeConfigPath);
const providers = objectField(openCodeConfig, 'provider');
const vercel = objectField(providers, 'vercel');
providers.vercel = { ...vercel, disabled: false };
openCodeConfig.provider = providers;

const openCodeDataRoot = managedDirectory('XDG_DATA_HOME', ['.local', 'share']);
const openCodeDataDir = ensureDirectory(path.join(openCodeDataRoot, 'opencode'));
const openCodeAuthPath = path.join(openCodeDataDir, 'auth.json');
const openCodeAuth = readJsonObject(openCodeAuthPath);
openCodeAuth.vercel = { type: 'api', key: agentKey };

const piDir = managedDirectory('PI_CODING_AGENT_DIR', ['.pi', 'agent']);
const piAuthPath = path.join(piDir, 'auth.json');
const piAuth = readJsonObject(piAuthPath);
piAuth['vercel-ai-gateway'] = { type: 'api_key', key: agentKey };

const codexDir = ensureDirectory(path.join(home, '.codex'));
const codexPath = path.join(codexDir, 'config.toml');
const managedRoot = new Map([
  ['model_provider', 'vercel'],
  ['model', ${JSON.stringify(codexModel)}],
]);
const managedVercel = new Map([
  ['name', 'Vercel AI Gateway'],
  ['base_url', 'https://ai-gateway.vercel.sh/codex/v1'],
  ['env_key', 'AI_GATEWAY_API_KEY'],
  ['wire_api', 'responses'],
]);
function assignmentIsComplete(lines, startIndex) {
  const first = lines[startIndex];
  const equals = first.indexOf('=');
  let value = first.slice(equals + 1);
  let bracket = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let multilineQuote = '';
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex++) {
    if (lineIndex > startIndex) value += '\\n' + lines[lineIndex];
    for (let index = 0; index < lines[lineIndex].length; index++) {
      const character = lines[lineIndex][index];
      const next1 = lines[lineIndex][index + 1] ?? '';
      const next2 = lines[lineIndex][index + 2] ?? '';
      if (multilineQuote) {
        if (character === multilineQuote && next1 === multilineQuote && next2 === multilineQuote) {
          multilineQuote = '';
          index += 2;
        }
        continue;
      }
      if (singleQuoted) {
        if (character === "'") singleQuoted = false;
        continue;
      }
      if (doubleQuoted) {
        if (character === '\\\\') index++;
        else if (character === '"') doubleQuoted = false;
        continue;
      }
      if (character === '#') break;
      if (character === '"' && next1 === '"' && next2 === '"') {
        multilineQuote = '"';
        index += 2;
      } else if (character === "'") {
        singleQuoted = true;
      } else if (character === '"') {
        doubleQuoted = true;
      } else if (character === '[') {
        bracket++;
      } else if (character === ']') {
        bracket--;
      }
    }
    if (!multilineQuote && !singleQuoted && !doubleQuoted && bracket <= 0) return lineIndex + 1;
  }
  throw new Error('malformed Codex TOML configuration');
}
function parseHeader(trimmed) {
  const arrayTable = trimmed.startsWith('[[') && trimmed.endsWith(']]');
  const regularTable = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!regularTable && !arrayTable) return null;
  const name = arrayTable ? trimmed.slice(2, -2) : trimmed.slice(1, -1);
  if (!name.trim()) throw new Error('malformed Codex TOML configuration');
  return { name: name.trim(), arrayTable };
}
function parseCodexConfig(lines) {
  const assignments = [];
  const headers = [];
  const seenKeys = new Set();
  const seenSections = new Set();
  let section = '';
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) {
      index++;
      continue;
    }
    const header = parseHeader(trimmed);
    if (header) {
      if (!header.arrayTable) {
        if (seenSections.has(header.name)) throw new Error('malformed Codex TOML configuration');
        seenSections.add(header.name);
      }
      if (header.name === 'model_providers.vercel' && header.arrayTable) {
        throw new Error('unsupported array table for model_providers.vercel');
      }
      headers.push({ index, ...header });
      section = header.name;
      index++;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\\s*=\\s*/.exec(trimmed);
    if (!match) throw new Error('malformed Codex TOML configuration');
    const keyId = section + '\\u0000' + match[1];
    if (seenKeys.has(keyId)) throw new Error('malformed Codex TOML configuration');
    seenKeys.add(keyId);
    const end = assignmentIsComplete(lines, index);
    assignments.push({ key: match[1], section, start: index, end });
    index = end;
  }
  return { assignments, headers };
}
function mergeToml() {
  const lines = (readConfiguration(codexPath) ?? '').split(/\\r?\\n/);
  const { assignments, headers } = parseCodexConfig(lines);
  const targetHeader = headers.find((header) => header.name === 'model_providers.vercel');
  const remove = new Set();
  const replace = new Map();
  for (const [managedKey, managedValue] of managedRoot) {
    const matches = assignments.filter((assignment) => assignment.section === '' && assignment.key === managedKey);
    if (matches.length > 0) {
      replace.set(matches[0].start, managedKey + ' = ' + JSON.stringify(managedValue));
      for (const match of matches) for (let index = match.start; index < match.end; index++) remove.add(index);
    }
  }
  for (const [managedKey, managedValue] of managedVercel) {
    const matches = assignments.filter((assignment) => assignment.section === 'model_providers.vercel' && assignment.key === managedKey);
    if (matches.length > 0) {
      replace.set(matches[0].start, managedKey + ' = ' + JSON.stringify(managedValue));
      for (const match of matches) for (let index = match.start; index < match.end; index++) remove.add(index);
    }
  }
  const output = [];
  const missingRoot = [...managedRoot].filter(([key]) => !assignments.some((assignment) => assignment.section === '' && assignment.key === key));
  for (const [key, value] of missingRoot) output.push(key + ' = ' + JSON.stringify(value));
  for (let index = 0; index < lines.length; index++) {
    const header = headers.find((candidate) => candidate.index === index);
    if (header) {
      output.push(lines[index]);
      if (header.name === 'model_providers.vercel') {
        for (const [key, value] of managedVercel) {
          if (!assignments.some((assignment) => assignment.section === header.name && assignment.key === key)) {
            output.push(key + ' = ' + JSON.stringify(value));
          }
        }
      }
      continue;
    }
    if (replace.has(index)) {
      output.push(replace.get(index));
      continue;
    }
    if (!remove.has(index)) output.push(lines[index]);
  }
  if (!targetHeader) {
    output.push('[model_providers.vercel]');
    for (const [key, value] of managedVercel) output.push(key + ' = ' + JSON.stringify(value));
  }
  return output.join('\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/\\n*$/, '\\n');
}

const paseoHome = ensureDirectory(${JSON.stringify(state.paseoHome)}, true);
const paseoConfigPath = path.join(paseoHome, 'config.json');
const paseoConfig = readJsonObject(paseoConfigPath);
if (preimages.get(paseoConfigPath) === 'MISSING') {
  Object.assign(paseoConfig, {
    version: 1,
    daemon: { listen: '127.0.0.1:6767', cors: { allowedOrigins: ['https://app.paseo.sh'] }, relay: { enabled: false } },
    app: { baseUrl: 'https://app.paseo.sh' },
  });
}
const agentProviders = objectField(objectField(paseoConfig, 'agents'), 'providers');
for (const provider of Object.values(agentProviders)) {
  requireObject(provider, 'agent provider');
  if (provider.env !== undefined) validateEnv(provider.env);
  if (provider.models !== undefined) validateModels(provider.models);
  if (provider.additionalModels !== undefined) validateModels(provider.additionalModels);
}
const copilot = objectField(agentProviders, 'copilot');
copilot.env = { ...objectField(copilot, 'env'), COPILOT_MODEL: ${JSON.stringify(copilotModel)} };
copilot.models = [{ id: ${JSON.stringify(copilotModel)}, label: 'Gateway', isDefault: true }];
const codex = objectField(agentProviders, 'codex');
const additions = codex.additionalModels ?? [];
const configuredModel = additions.find((model) => model.id === ${JSON.stringify(codexModel)}) ?? { id: ${JSON.stringify(codexModel)}, label: 'Gateway' };
codex.additionalModels = [...additions.filter((model) => model.id !== configuredModel.id), configuredModel];

const codexConfig = mergeToml();
const writes = [
  serializeJson(claudePath, claude),
  serializeJson(openCodeConfigPath, openCodeConfig),
  serializeJson(openCodeAuthPath, openCodeAuth),
  serializeJson(piAuthPath, piAuth),
  [codexPath, codexConfig],
  serializeJson(paseoConfigPath, paseoConfig),
];
const receiptDirectory = ensureDirectory(path.join(paseoHome, 'provider-config-receipts'), true);
const locks = [];
try {
  for (const [file] of writes) {
    const lock = file + '.edit-lock';
    const fd = fs.openSync(lock, 'wx', 0o600);
    locks.push([lock, fd]);
  }
  for (const [file] of writes) assertUnchanged(file);
  for (const [file, contents] of writes) atomicWrite(file, contents, receiptDirectory);
} finally {
  for (const [lock, fd] of locks.reverse()) { fs.closeSync(fd); fs.unlinkSync(lock); }
}
`;
}
