# Protocol Validator Codegen

This directory is build-time only. The generator writes `generated/ws-outbound.compile.ts`, the zod-aot discovery entry for the inbound WebSocket validators: one for the envelope and one per session message type.

The discovery entry and the generated runtime files under `../src/generated/validation/` are not committed. The protocol package owns every generation trigger through its npm lifecycle scripts.

`zod-aot` is exact-pinned, and the protocol generator applies the small compiler patches it requires before generation. Treat changes to those patches like compiler changes: regenerate, inspect the output, and run the protocol validation regression tests before shipping.
