# Protocol Validator Codegen

This directory is build-time only. `ws-outbound.compile.ts` is the zod-aot discovery entry for the inbound WebSocket validator.

The generated runtime file is written to `../src/generated/validation/ws-outbound.aot.ts` and is not committed. The protocol package owns every generation trigger through its npm lifecycle scripts.

`zod-aot` is exact-pinned and locally patched. Treat changes to the patch like compiler changes: regenerate, inspect the output, and run the protocol validation differential tests before shipping.
