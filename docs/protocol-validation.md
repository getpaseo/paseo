# Protocol Validation

Paseo authors WebSocket schemas in Zod, but the client's inbound WebSocket hot path uses a build-time generated zod-aot validator.

The reason is mobile performance. A captured 353 KB provider snapshot cost about 10.9 ms and 5.9 MB allocated per message for `JSON.parse` plus Zod on Hermes. After moving the model normalization transform out of the schema so zod-aot could compile the hot subtree, the generated validator path measured about 2.5 ms and 1.2 MB allocated.

## Architecture

Zod remains the source of truth for protocol authoring, TypeScript inference, and test/dev differential checking.

The generated validator is production runtime for inbound client messages:

1. The client receives text from the WebSocket.
2. `JSON.parse` produces an unknown object.
3. `validateWSOutboundMessage()` runs the generated `WSOutboundMessageSchema.safeParse`.
4. On success, explicit post-validation normalization fills parser-side derived fields such as `defaultThinkingOptionId`.
5. On failure, the client warns and drops the message, matching the old behavior.

Outbound client validation still uses Zod directly. That path is not in this optimization.

## Generation

The compile wrapper lives at `packages/protocol/src/validation/ws-outbound-aot-source.ts`.

Generated output is written to:

```text
packages/protocol/src/generated/validation/ws-outbound.aot.ts
```

That file is gitignored. The directory keeps a committed `README.md` so missing generated output has a clear owner and command:

```bash
npm run generate:validation-aot --workspace=@getpaseo/protocol
```

Generation runs from the protocol package's build, typecheck, and test scripts, from root dev/app flows, from EAS post-install, and explicitly in CI. A fresh clone should be able to delete the generated file and still pass `npm run typecheck`.

zod-aot is exact-pinned because it is a young solo-maintainer project. Treat upgrades like compiler upgrades: regenerate, inspect, and rely on differential tests.

## Semantic Delta

Zod object parsing strips unknown object keys by default. The generated zod-aot validator returns the original parsed object, so unknown keys are preserved.

This is deliberate for the client inbound path. The audit result is that client dispatch uses known `type` and payload fields; it does not rely on unknown-key stripping for behavior. Dev and CI comparison accounts for this by re-parsing the generated output through the Zod schema before deep comparison.

Protocol compatibility is unchanged. The wire format did not change; only the parser implementation changed.

## Schema Purity Rules

Message schemas are structural declarations. Do not put `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas. If parsed data needs normalization, put it in an explicit post-validation pass.

Use `z.discriminatedUnion()` when every branch has a shared literal tag. Plain `z.union()` is acceptable only when there is no shared literal discriminator or when zod-aot is known to generate incorrect code for that shape.

Defaults are allowed only on primitive leaves. Do not place `.default()` on large arrays, item schemas, or big containers in inbound message schemas; that forces runtime fallback work into the hot path.

## Differential Gates

zod-aot 0.20.4 miscompiled a nested discriminated union for timeline `tool_call` items during benchmarking: the generated outer dispatch omitted the nested `tool_call` branch. That incident is why correctness gates are load-bearing.

The protocol test fixtures compare Zod and generated validation on:

- the captured provider snapshot
- the captured timeline response
- the captured agent stream burst
- corrupted variants rejected by both validators
- explicit `tool_call` samples for every status

The client also runs a dev-only differential check. It compares accept/reject behavior and compares Zod output to generated output after stripping generated passthrough keys through the Zod schema. Production builds skip this work.
