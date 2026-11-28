import {
  AGENT_SNAPSHOT_DEFAULTS,
  HELLO_REJECTED_REASONS,
  SESSION_INBOUND_DEFAULTS,
  SESSION_OUTBOUND_DEFAULTS,
} from "../generated/validation/message-defaults.js";

export type DefaultsLiteral = string | number | boolean;

export type DefaultsNode =
  | { readonly k: "d"; readonly v: unknown; readonly i?: DefaultsNode }
  | { readonly k: "f"; readonly from: string }
  | { readonly k: "o"; readonly p: Readonly<Record<string, DefaultsNode>> }
  | { readonly k: "a"; readonly e: DefaultsNode }
  | { readonly k: "r"; readonly e: DefaultsNode }
  | {
      readonly k: "m";
      readonly b: readonly {
        readonly m: Readonly<Record<string, DefaultsLiteral>>;
        readonly n: DefaultsNode;
      }[];
    }
  | { readonly k: "s"; readonly s: readonly DefaultsNode[] };

export { HELLO_REJECTED_REASONS };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDefaultValue(item));
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneDefaultValue(entry);
    }
    return copy;
  }
  return value;
}

function matchesLiterals(
  record: Record<string, unknown>,
  expected: Readonly<Record<string, DefaultsLiteral>>,
): boolean {
  for (const [key, literal] of Object.entries(expected)) {
    if (record[key] !== literal) {
      return false;
    }
  }
  return true;
}

function applyObjectDefaults(
  value: Record<string, unknown>,
  props: Readonly<Record<string, DefaultsNode>>,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(props)) {
    const current = value[key];
    if (child.k === "f") {
      const fallback = current === undefined || current === null ? value[child.from] : undefined;
      if (fallback !== undefined) {
        if (!next) next = { ...value };
        next[key] = fallback;
      }
      continue;
    }
    if (current === undefined) {
      if (child.k !== "d") continue;
      if (!next) next = { ...value };
      next[key] = cloneDefaultValue(child.v);
      continue;
    }
    const updated = applyNode(current, child);
    if (updated !== current) {
      if (!next) next = { ...value };
      next[key] = updated;
    }
  }
  return next ?? value;
}

function applyArrayDefaults(value: unknown[], element: DefaultsNode): unknown[] {
  let next: unknown[] | null = null;
  for (let i = 0; i < value.length; i++) {
    const current = value[i];
    const updated = applyNode(current, element);
    if (updated !== current) {
      if (!next) next = value.slice();
      next[i] = updated;
    }
  }
  return next ?? value;
}

function applyRecordDefaults(
  value: Record<string, unknown>,
  element: DefaultsNode,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const [key, current] of Object.entries(value)) {
    const updated = applyNode(current, element);
    if (updated !== current) {
      if (!next) next = { ...value };
      next[key] = updated;
    }
  }
  return next ?? value;
}

function applyNode(value: unknown, node: DefaultsNode): unknown {
  if (node.k === "d") {
    if (value === undefined) return cloneDefaultValue(node.v);
    return node.i ? applyNode(value, node.i) : value;
  }
  if (node.k === "o") {
    return isRecord(value) ? applyObjectDefaults(value, node.p) : value;
  }
  if (node.k === "a") {
    return Array.isArray(value) ? applyArrayDefaults(value, node.e) : value;
  }
  if (node.k === "r") {
    return isRecord(value) ? applyRecordDefaults(value, node.e) : value;
  }
  if (node.k === "s") {
    let current = value;
    for (const step of node.s) {
      current = applyNode(current, step);
    }
    return current;
  }
  if (node.k === "m" && isRecord(value)) {
    for (const branch of node.b) {
      if (matchesLiterals(value, branch.m)) {
        return applyNode(value, branch.n);
      }
    }
  }
  return value;
}

export function applyAgentSnapshotDefaults(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return AGENT_SNAPSHOT_DEFAULTS
    ? (applyNode(snapshot, AGENT_SNAPSHOT_DEFAULTS) as Record<string, unknown>)
    : snapshot;
}

export function applySessionOutboundDefaults(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const type = message.type;
  if (typeof type !== "string") return message;
  const node = SESSION_OUTBOUND_DEFAULTS[type];
  return node ? (applyNode(message, node) as Record<string, unknown>) : message;
}

export function applySessionInboundDefaults(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const type = message.type;
  if (typeof type !== "string") return message;
  const node = SESSION_INBOUND_DEFAULTS[type];
  return node ? (applyNode(message, node) as Record<string, unknown>) : message;
}
