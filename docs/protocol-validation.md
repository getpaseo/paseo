# Protocol Validation

The client validates inbound WebSocket messages with a zod-aot generated validator instead of runtime Zod on the hot path. Zod remains the authoring source of truth for schemas and TypeScript types.

The reason is mobile performance. A captured 353 KB provider snapshot cost about 10.9 ms and 5.9 MB allocated per message for `JSON.parse` plus Zod on Hermes. After moving provider-model normalization out of the schema so zod-aot could compile the hot subtree, the generated validator path measured about 2.5 ms and 1.2 MB allocated.

## Runtime Path

`packages/protocol/src/validation/ws-outbound.ts` is the shipped boundary. It calls the generated `WSOutboundMessageSchema.safeParse` and returns the validated data. It does not normalize, repair, or re-validate the generated result.

Generated validators preserve unknown keys where Zod object parsing strips them. The client dispatch path uses known `type` and payload fields, so this passthrough behavior is accepted for inbound messages. The wire format is unchanged.

Provider model normalization is a parser-side compatibility shim in the client consumers that need it. Newer daemons normalize at the provider registry source.

## Codegen Ownership

The protocol package owns generation.

- `packages/protocol/codegen/ws-outbound.compile.ts` is the build-time zod-aot discovery entry.
- `packages/protocol/scripts/generate-validation-aot.mjs` runs the exact-pinned compiler and applies the small local compiler patches before generation.
- `packages/protocol/scripts/watch-validation-aot.mjs` reruns generation while editing protocol sources.
- `packages/protocol/src/generated/validation/ws-outbound.aot.ts` is generated runtime code and is gitignored.
- `packages/protocol/src/validation/ws-outbound-schema-metadata.ts` is runtime schema metadata for zod-aot fallback/default references.

Generation runs from protocol-owned lifecycle hooks: `prebuild`, `pretypecheck`, `pretest`, and `watch`. Installs do not run generation: published packages consume protocol from prebuilt `dist`, and local build/typecheck/test flows generate the source file at the point it is actually needed.

## Regression Tests

zod-aot is exact-pinned and young enough that compiler patches are treated as part of this package. `packages/protocol/tests/validation/ws-outbound.test.ts` keeps small regression tests for the patched cases:

- discriminated-union branch output must propagate `.default()` fields
- current sequential item routing must accept `tool_call`-like status branches
- generated runtime imports must keep `.js` extensions for packaged Node ESM
- the generated WebSocket envelope accepts a minimal valid message and rejects a corrupted one

## Schema Purity

Message schemas are structural declarations. Do not put `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas. If parsed data needs normalization, put it in an explicit consumer or post-validation pass.

Use `z.discriminatedUnion()` when every branch has a shared literal tag. Plain `z.union()` is acceptable only when there is no shared literal discriminator or when a generated-code regression test proves that specific shape is miscompiled.

Defaults are allowed only on primitive leaves. Do not place `.default()` on large arrays, item schemas, or big containers in inbound message schemas.
