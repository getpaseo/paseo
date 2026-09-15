# Attribution

`TailFadeInAnimator.kt` and `FadeInSpan.kt` adapt Software Mansion's native
text-range animation from `enriched-markdown`, commit
`019b88facf23de7b84a1b044e368e49a62b6d66c`. Its MIT license is in `LICENSE`.

Paseo supplies word-paced text and message-owned fade ranges with their original
start times and the interval each word owns before the next. The adapter applies
those ranges to the child text surface in the same Fabric transaction and retains the upstream
`CharacterStyle` alpha span. Upstream drives one `ValueAnimator` per appended
tail; Paseo gives every grapheme an absolute start time in native Unicode visual
order and ticks one `Choreographer` clock per surface, so consecutive words form
one front. It does not own Markdown parsing or network pacing.

Do not put a gradient shader on `TextPaint`: Android also uses that paint for
inline-code backgrounds, making them flash in the foreground color.

Do not require `TextView.layout` to start a fade. React Native can replace text
while keeping its bounds, leaving layout null until `TextView.onDraw`. Requiring
layout in pre-draw silently skips those appended words.

FlatList clipping can detach a host while its React component remains mounted.
Stop its clock on detach and reconnect pre-draw on attach. Resume using the
message's absolute start times; never infer an appended suffix from native text.
The host's ranges prop and child text share Fabric's mount transaction.

Observe the read-only text before painting. Registering a `TextWatcher` makes
Android convert later text replacements into `Editable`, changing its layout
and drawing-cache path. The binding must preserve RN's original text buffer.

`ios/internal/TailFadeInAnimator.swift` adapts Software Mansion's
`ios/utils/ENRMTailFadeInAnimator.m` at commit
`4c1270f48f19f5da88bc0b751e2a070bd0f989b9`: original-color snapshots,
`NSTextStorage` foreground attributes, and a `CADisplayLink` that stops when the
tail settles. Paseo retains its word pacing; each grapheme has an absolute start
time and the same 150 ms linear envelope, and CoreText supplies visual grapheme order.

The existing RN UITextView host assigns attributed text during `drawRect`. Flush
its pending display before applying ranges, otherwise the observer can
animate hydrated history or miss the final appended word. Incoming attributed
text may preserve already-faded colors; distinguish those from replacement
styles before refreshing original-color snapshots.

The wrapping host owns exactly one animator. Prop updates replace its ranges;
recycling releases its attributes and clock. There is no React-tag registry or
associated-object owner on a text view.
