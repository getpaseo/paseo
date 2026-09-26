# Native diff layout experiment

Android-only Expo module for evaluating background wrapped-text layout. The normal
diff surface does not call this module; it still uses the JavaScript model and
renderer. This is a checkpoint of the layout experiment, not a replacement renderer.

The C++ core owns cell text and wrapped grapheme geometry. Kotlin/JNI supplies the
Android font manager and dispatches preparation through Expo's background queue.
It links the Skia libraries shipped by the installed React Native Skia package.
An iOS binding, renderer integration, and shipping library ownership are unfinished.

## Diagnostic interface

Access the module through `expo.modules.PaseoDiffPrototype` in a development build:

- `create()` returns a numeric handle.
- `prepare(handle, texts, widths, family, fontSize)` asynchronously builds geometry
  and returns counts, copy/layout timings, and a partial geometry allocation estimate.
  Text and width arrays must have matching lengths. Input is copied; it is not zero-copy.
- `read(handle, startCell, count)` synchronously returns packed numerical geometry
  for at most 256 cells. This exists for parity checks, not whole-model transfer.
- `release(handle)` cancels pending work and releases ownership. Release handles
  after success or failure; module destruction also cancels and releases all handles.

Each packed cell begins with its index and fragment count. Each fragment contains
UTF-16 start/end offsets, width, and grapheme count, followed by each grapheme's
UTF-16 start/end offsets and width. The caller retains source text.

The experiment accepts normalized cell inputs. It does not parse wire payloads,
construct file/header/review models, apply highlighting, or draw pixels. A renderer
integration must preserve native ownership and request bounded visible data rather
than reconstructing the entire JavaScript graph.

Grapheme property ranges are generated at build time from the installed JavaScript
dependency so segmentation uses the same data as the reference implementation.
