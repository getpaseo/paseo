# Protocol Validator Codegen

This directory is build-time only. `ws-outbound.compile.ts` is the zod-aot discovery entry for the inbound WebSocket validator.

The generated runtime file is written to `../src/generated/validation/ws-outbound.aot.ts` and is not committed. The protocol package owns every generation trigger through its npm lifecycle scripts.

`zod-aot` is exact-pinned, and the protocol generator applies the small compiler patches it requires before generation. Treat changes to those patches like compiler changes: regenerate, inspect the output, and run the protocol validation regression tests before shipping.
