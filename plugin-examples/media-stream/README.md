# Media stream plugin example

One subscription carries two binary streams. Each pushed `Uint8Array` is a binary frame; its first
byte says whether it is video, a keyframe, or audio.

```bash
paseo plugin add /absolute/path/to/paseo/plugin-examples/media-stream
```

- `shared/media-frames.ts` owns the byte layout: `encodeMediaFrame`, `decodeMediaFrame`, and the
  `media.stream` contract. `decodeMediaFrame` returns a view, so the panel never copies a payload.
- `server/test-pattern.ts` is a synthetic source; replace it with a real capture.
- `index.server.ts` pushes each source callback as a frame and stops the source when the
  subscription's `signal` aborts.
- `client/media-panel.tsx` decodes each frame and routes it by opcode.
- `shared/frame-check.ts` is an RPC whose input is a `Uint8Array`: the panel uploads the picture
  on screen and `server/frame-check.ts` reports its size and checksum.
