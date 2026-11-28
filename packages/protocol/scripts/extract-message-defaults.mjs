function isPrimitiveLiteral(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function getDef(schema) {
  return schema?._zod?.def ?? null;
}

function unwrapToObjectOrUnion(schema, seen = new Set()) {
  const def = getDef(schema);
  if (!def || seen.has(schema)) return null;
  seen.add(schema);

  if (
    def.type === "optional" ||
    def.type === "nullable" ||
    def.type === "readonly" ||
    def.type === "catch" ||
    def.type === "prefault" ||
    def.type === "default"
  ) {
    return unwrapToObjectOrUnion(def.innerType, seen);
  }
  if (def.type === "pipe") {
    return unwrapToObjectOrUnion(def.in, seen) ?? unwrapToObjectOrUnion(def.out, seen);
  }
  if (def.type === "lazy") {
    return unwrapToObjectOrUnion(def.getter(), seen);
  }
  return schema;
}

function extractSingleLiteral(schema) {
  const def = getDef(schema);
  if (!def) return undefined;
  if (def.type === "literal" && Array.isArray(def.values) && def.values.length === 1) {
    const value = def.values[0];
    return isPrimitiveLiteral(value) ? value : undefined;
  }
  return undefined;
}

function extractObjectLiterals(schema) {
  const unwrapped = unwrapToObjectOrUnion(schema);
  const def = getDef(unwrapped);
  if (!def || def.type !== "object") return {};

  const literals = {};
  for (const [key, propSchema] of Object.entries(def.shape)) {
    const literal = extractSingleLiteral(propSchema);
    if (literal !== undefined) {
      literals[key] = literal;
    }
  }
  return literals;
}

function flattenUnionOptions(options) {
  const flattened = [];
  for (const option of options) {
    const unwrapped = unwrapToObjectOrUnion(option);
    const def = getDef(unwrapped);
    if (def?.type === "union") {
      flattened.push(...flattenUnionOptions(def.options));
    } else {
      flattened.push(option);
    }
  }
  return flattened;
}

function mergeObjectProps(left, right) {
  const merged = { ...left };
  for (const [key, node] of Object.entries(right)) {
    if (key in merged && merged[key].k === "o" && node.k === "o") {
      merged[key] = { k: "o", p: mergeObjectProps(merged[key].p, node.p) };
    } else {
      merged[key] = node;
    }
  }
  return merged;
}

function extractObjectNode(def, seen, ctx) {
  const props = {};
  let hasProps = false;
  for (const [key, propSchema] of Object.entries(def.shape)) {
    const child = extractDefaultsNode(propSchema, new Set(seen), {
      ...ctx,
      path: `${ctx.path}.${key}`,
    });
    if (child) {
      props[key] = child;
      hasProps = true;
    }
  }
  return hasProps ? { k: "o", p: props } : null;
}

function extractUnionNode(def, seen, ctx) {
  const branches = [];
  const options = flattenUnionOptions(def.options);
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const child = extractDefaultsNode(option, new Set(seen), {
      ...ctx,
      path: `${ctx.path}|${i}`,
    });
    if (!child) continue;
    const match = extractObjectLiterals(option);
    if (Object.keys(match).length === 0) {
      throw new Error(
        `Protocol union branch at ${ctx.path}|${i} contains .default() without literal object discriminators`,
      );
    }
    branches.push({ m: match, n: child });
  }
  return branches.length > 0 ? { k: "m", b: branches } : null;
}

function extractIntersectionNode(def, seen, ctx) {
  const left = extractDefaultsNode(def.left, new Set(seen), ctx);
  const right = extractDefaultsNode(def.right, new Set(seen), ctx);
  if (!left) return right;
  if (!right) return left;
  if (left.k === "o" && right.k === "o") {
    return { k: "o", p: mergeObjectProps(left.p, right.p) };
  }
  const leftSteps = left.k === "s" ? left.s : [left];
  const rightSteps = right.k === "s" ? right.s : [right];
  return { k: "s", s: [...leftSteps, ...rightSteps] };
}

function extractPipeNode(def, seen, ctx) {
  const left = extractDefaultsNode(def.in, new Set(seen), ctx);
  const right = extractDefaultsNode(def.out, new Set(seen), ctx);
  if (!left) return right;
  if (!right) return left;
  if (left.k === "o" && right.k === "o") {
    return { k: "o", p: mergeObjectProps(left.p, right.p) };
  }
  return right;
}

const WRAPPER_DEF_TYPES = new Set(["optional", "nullable", "readonly"]);

// Existing legacy `.catch()` and `.transform()` schemas whose behavior is not read by lean CLI
// commands today (or already covered by a parent entry in `legacySchemaTransformDefaults`).
// Any NEW `.catch()` or `.transform()` in protocol message schemas fails `generate:validators`
// so lean clients never silently drift from strict Zod parsing (see docs/protocol-validation.md).
const KNOWN_LEGACY_NON_PURE_ANCHORS = new Set([
  "out:workspace_update.payload|0.workspace.statusEnteredAt",
  "out:workspace_update.payload|0.workspace.githubRuntime.pullRequest.mergeable",
  "out:project.add.response.payload.errorCode",
  "out:open_project_response.payload.errorCode",
  "out:agent.fork_context.response.payload.attachment",
  "out:read_project_config_response.payload|0.config.metadataGeneration",
  "out:read_project_config_response.payload|0.config.metadataGeneration.title",
  "out:checkout_status_update.payload.prStatus.status.mergeable",
  "out:pull_request_timeline_response.payload.items[]",
  "out:pull_request_timeline_response.payload.error",
  "out:list_commands_response.payload.commands[].kind",
  "out:list_terminals_response.payload.terminals[].activity.state",
  "out:list_terminals_response.payload.terminals[].activity.attentionReason",
  "in:send_agent_message_request.attachments",
]);

function extractDefaultNode(kind, def, seen, ctx) {
  const rawValue = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
  const serialized = JSON.stringify(rawValue);
  if (serialized === undefined) {
    throw new Error("Protocol .default()/.prefault() value must be JSON-serializable");
  }
  const inner = extractDefaultsNode(def.innerType, new Set(seen), ctx);
  return inner
    ? { k: kind, v: JSON.parse(serialized), i: inner }
    : { k: kind, v: JSON.parse(serialized) };
}

function mergeExtraObjectProps(node, extraProps) {
  if (!extraProps) return node;
  if (!node) return { k: "o", p: { ...extraProps } };
  if (node.k === "o") return { k: "o", p: mergeObjectProps(node.p, extraProps) };
  return { k: "s", s: [node, { k: "o", p: { ...extraProps } }] };
}

function assertNonPureSchemaAllowed(schema, defType, ctx) {
  if (ctx.extraPropsMap?.has(schema) || ctx.allowedNonPureSchemas.has(schema)) {
    return;
  }
  throw new Error(
    `Unlisted protocol .${defType === "pipe" ? "transform()/.preprocess()" : `${defType}()`} schema at ${ctx.path}. ` +
      "Avoid non-pure wire schemas (see docs/protocol-validation.md) or register its lean rule in ws-outbound-envelope.ts.",
  );
}

function extractBaseDefaultsNode(schema, def, seen, ctx) {
  if (def.type === "default") return extractDefaultNode("d", def, seen, ctx);
  if (def.type === "prefault") return extractDefaultNode("p", def, seen, ctx);
  if (def.type === "catch") {
    assertNonPureSchemaAllowed(schema, "catch", ctx);
    return extractDefaultsNode(def.innerType, new Set(seen), ctx);
  }
  if (WRAPPER_DEF_TYPES.has(def.type)) {
    return extractDefaultsNode(def.innerType, new Set(seen), ctx);
  }
  if (def.type === "lazy") return extractDefaultsNode(def.getter(), new Set(seen), ctx);
  if (def.type === "pipe") {
    assertNonPureSchemaAllowed(schema, "pipe", ctx);
    return extractPipeNode(def, seen, ctx);
  }
  if (def.type === "object") return extractObjectNode(def, seen, ctx);
  if (def.type === "array") {
    const element = extractDefaultsNode(def.element, new Set(seen), {
      ...ctx,
      path: `${ctx.path}[]`,
    });
    return element ? { k: "a", e: element } : null;
  }
  if (def.type === "record") {
    const valueNode = extractDefaultsNode(def.valueType, new Set(seen), {
      ...ctx,
      path: `${ctx.path}{}`,
    });
    return valueNode ? { k: "r", e: valueNode } : null;
  }
  if (def.type === "union") return extractUnionNode(def, seen, ctx);
  if (def.type === "intersection") return extractIntersectionNode(def, seen, ctx);
  return null;
}

function extractDefaultsNode(schema, seen = new Set(), ctx = null) {
  const def = getDef(schema);
  if (!def || seen.has(schema)) return null;
  seen.add(schema);
  const base = extractBaseDefaultsNode(schema, def, seen, ctx);
  return mergeExtraObjectProps(base, ctx?.extraPropsMap?.get(schema) ?? null);
}

function indexNonPureSchemas(schema, path, seen, index) {
  const def = getDef(schema);
  if (!def || seen.has(schema)) return;
  seen.add(schema);
  if ((def.type === "catch" || def.type === "pipe") && KNOWN_LEGACY_NON_PURE_ANCHORS.has(path)) {
    index.add(schema);
  }
  if (def.innerType) indexNonPureSchemas(def.innerType, path, new Set(seen), index);
  if (def.in) indexNonPureSchemas(def.in, path, new Set(seen), index);
  if (def.out) indexNonPureSchemas(def.out, path, new Set(seen), index);
  if (def.getter) indexNonPureSchemas(def.getter(), path, new Set(seen), index);
  if (def.shape) {
    for (const [k, v] of Object.entries(def.shape)) {
      indexNonPureSchemas(v, `${path}.${k}`, new Set(seen), index);
    }
  }
  if (def.element) indexNonPureSchemas(def.element, `${path}[]`, new Set(seen), index);
  if (def.valueType) indexNonPureSchemas(def.valueType, `${path}{}`, new Set(seen), index);
  if (def.options) {
    for (let i = 0; i < def.options.length; i++) {
      indexNonPureSchemas(def.options[i], `${path}|${i}`, new Set(seen), index);
    }
  }
  if (def.left) indexNonPureSchemas(def.left, path, new Set(seen), index);
  if (def.right) indexNonPureSchemas(def.right, path, new Set(seen), index);
}

function collectMessageDefaults(prefix, options, extraPropsMap, allowedNonPureSchemas) {
  const map = {};
  for (const option of options) {
    const tag = option.shape.type.value;
    const node = extractDefaultsNode(option, new Set(), {
      path: `${prefix}:${tag}`,
      extraPropsMap,
      allowedNonPureSchemas,
    });
    if (node) {
      map[tag] = node;
    }
  }
  return map;
}

function countSubtreeReferences(node, counts) {
  const key = JSON.stringify(node);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (counts.get(key) > 1) return;

  if (node.k === "d" || node.k === "p") {
    if (node.i) countSubtreeReferences(node.i, counts);
  } else if (node.k === "o") {
    for (const child of Object.values(node.p)) {
      countSubtreeReferences(child, counts);
    }
  } else if (node.k === "a" || node.k === "r") {
    countSubtreeReferences(node.e, counts);
  } else if (node.k === "m") {
    for (const branch of node.b) {
      countSubtreeReferences(branch.n, counts);
    }
  } else if (node.k === "s") {
    for (const step of node.s) {
      countSubtreeReferences(step, counts);
    }
  }
}

function emitNodeExpr(node, sharedRefs, allowRef = true) {
  const key = JSON.stringify(node);
  if (allowRef && sharedRefs.has(key)) {
    return sharedRefs.get(key);
  }
  if (node.k === "d" || node.k === "p") {
    return node.i
      ? `{ k: ${JSON.stringify(node.k)}, v: ${JSON.stringify(node.v)}, i: ${emitNodeExpr(node.i, sharedRefs)} }`
      : `{ k: ${JSON.stringify(node.k)}, v: ${JSON.stringify(node.v)} }`;
  }
  if (node.k === "f") {
    return `{ k: "f", from: ${JSON.stringify(node.from)} }`;
  }
  if (node.k === "o") {
    const props = Object.entries(node.p)
      .map(([k, v]) => `${JSON.stringify(k)}: ${emitNodeExpr(v, sharedRefs)}`)
      .join(", ");
    return `{ k: "o", p: { ${props} } }`;
  }
  if (node.k === "a" || node.k === "r") {
    return `{ k: ${JSON.stringify(node.k)}, e: ${emitNodeExpr(node.e, sharedRefs)} }`;
  }
  if (node.k === "m") {
    const branches = node.b
      .map(
        (branch) => `{ m: ${JSON.stringify(branch.m)}, n: ${emitNodeExpr(branch.n, sharedRefs)} }`,
      )
      .join(", ");
    return `{ k: "m", b: [${branches}] }`;
  }
  if (node.k === "s") {
    const steps = node.s.map((step) => emitNodeExpr(step, sharedRefs)).join(", ");
    return `{ k: "s", s: [${steps}] }`;
  }
  throw new Error(`Unknown defaults node kind: ${node.k}`);
}

function collectOrderedSharedNodes(node, counts, visited, ordered) {
  const key = JSON.stringify(node);
  if (visited.has(key)) return;
  visited.add(key);

  if ((node.k === "d" || node.k === "p") && node.i) {
    collectOrderedSharedNodes(node.i, counts, visited, ordered);
  } else if (node.k === "o") {
    for (const child of Object.values(node.p)) {
      collectOrderedSharedNodes(child, counts, visited, ordered);
    }
  } else if (node.k === "a" || node.k === "r") {
    collectOrderedSharedNodes(node.e, counts, visited, ordered);
  } else if (node.k === "m") {
    for (const branch of node.b) {
      collectOrderedSharedNodes(branch.n, counts, visited, ordered);
    }
  } else if (node.k === "s") {
    for (const step of node.s) {
      collectOrderedSharedNodes(step, counts, visited, ordered);
    }
  }

  if ((counts.get(key) ?? 0) >= 2 && key.length > 40) {
    ordered.push([key, node]);
  }
}

export function generateMessageDefaultsModule({
  sessionOutboundMessageOptions,
  sessionInboundMessageOptions,
  helloRejectedReasons,
  agentSnapshotPayloadSchema,
  legacySchemaTransformDefaults,
}) {
  const allowedNonPureSchemas = new Set();
  for (const option of sessionOutboundMessageOptions) {
    indexNonPureSchemas(option, `out:${option.shape.type.value}`, new Set(), allowedNonPureSchemas);
  }
  for (const option of sessionInboundMessageOptions) {
    indexNonPureSchemas(option, `in:${option.shape.type.value}`, new Set(), allowedNonPureSchemas);
  }

  const outbound = collectMessageDefaults(
    "out",
    sessionOutboundMessageOptions,
    legacySchemaTransformDefaults,
    allowedNonPureSchemas,
  );
  const inbound = collectMessageDefaults(
    "in",
    sessionInboundMessageOptions,
    legacySchemaTransformDefaults,
    allowedNonPureSchemas,
  );
  const agentSnapshot = extractDefaultsNode(agentSnapshotPayloadSchema, new Set(), {
    path: "agentSnapshot",
    extraPropsMap: legacySchemaTransformDefaults,
    allowedNonPureSchemas,
  });

  const allNodes = [
    ...Object.values(outbound),
    ...Object.values(inbound),
    ...(agentSnapshot ? [agentSnapshot] : []),
  ];

  const counts = new Map();
  for (const node of allNodes) {
    countSubtreeReferences(node, counts);
  }

  const visited = new Set();
  const ordered = [];
  for (const node of allNodes) {
    collectOrderedSharedNodes(node, counts, visited, ordered);
  }

  const sharedRefs = new Map();
  const decls = [];
  for (const [index, [key, node]] of ordered.entries()) {
    const name = `d${index}`;
    decls.push(`const ${name}: DefaultsNode = ${emitNodeExpr(node, sharedRefs, false)};`);
    sharedRefs.set(key, name);
  }

  const formatMap = (name, map) => [
    `export const ${name}: Readonly<Record<string, DefaultsNode>> = {`,
    ...Object.entries(map).map(
      ([tag, node]) => `  ${JSON.stringify(tag)}: ${emitNodeExpr(node, sharedRefs)},`,
    ),
    "};",
  ];

  const lines = [
    "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
    'import type { DefaultsNode } from "../../validation/message-defaults.js";',
    "",
    `export const HELLO_REJECTED_REASONS: readonly string[] = ${JSON.stringify(helloRejectedReasons)};`,
    "",
    ...decls,
    ...(decls.length > 0 ? [""] : []),
    `export const AGENT_SNAPSHOT_DEFAULTS: DefaultsNode | null = ${agentSnapshot ? emitNodeExpr(agentSnapshot, sharedRefs) : "null"};`,
    "",
    ...formatMap("SESSION_OUTBOUND_DEFAULTS", outbound),
    "",
    ...formatMap("SESSION_INBOUND_DEFAULTS", inbound),
    "",
  ];

  return {
    content: lines.join("\n"),
    outboundCount: Object.keys(outbound).length,
    inboundCount: Object.keys(inbound).length,
  };
}
