# Composer Tokens

Commands and skills selected from composer autocomplete render as pills on web. This
note covers the model, the web renderer, and why native deliberately stays plain text.

## The model: tokens are a view, never state

A token is re-derived from the composer's plain text on every render. Nothing about a
token is stored anywhere.

```
"please run /release-beta"  →  collectComposerTokens()  →  [{ type: "skill", name: "release-beta", start: 11, end: 24 }]
```

`packages/app/src/composer/tokens/tokens.ts` owns this. `collectComposerTokens` finds
canonical slash-shaped text and keeps only names present in the current command/skill
catalog; `segmentComposerText` splits the draft into alternating plain/token segments
covering the whole string, each carrying its source offset.

Because text is still the only source of truth, drafts, dictation and undo need no
parallel token state. Choosing an autocomplete option replaces the configured trigger
with canonical `/name` syntax immediately. Submission and queueing send that exact
string without another interpretation pass. **Do not add a parallel token array to
composer state.**

Detection rules:

- Configured triggers open autocomplete but are not tokens by themselves. A selection
  explicitly commits the chosen command or skill to canonical slash syntax.
- Enter or Tab commits the highlighted autocomplete option, regardless of which
  configured trigger opened the menu. The exception is a `$` trigger whose name follows
  the shell-variable identifier shape: Enter submits it as text, while Tab or a click
  explicitly commits the colliding skill.
- A leading canonical slash means a command; a canonical slash after whitespace means a
  skill. Slash-delimited paths are not tokens.
- A slash glued to a preceding word is prose. `and/or` and `/tmp/project` therefore stay
  plain text.
- A name is `[A-Za-z][A-Za-z0-9:_-]*`. A bare sigil with no name is not a token.
- A syntactically valid name that is absent from the current command catalog is prose.
- Unselected text is never rewritten. `$HOME` remains `$HOME` even if the provider
  exposes a skill named `HOME`; only choosing that autocomplete option commits `/HOME`.

## Sigils are configurable

`packages/app/src/composer/tokens/sigils.ts`. Two settings — `commandTriggerSigil` and
`skillTriggerSigil` — default to `/` and `$`. The choices are an allowlist
(`COMPOSER_SIGIL_CHOICES`), not free text: a letter or digit would open the menu
constantly, and `@` is reserved for file mentions.

`resolveComposerSigils()` coerces a stored pair into a valid, collision-free one, and
**every consumer must go through it** (or through `useComposerSigils()`, which wraps it)
rather than reading the two settings directly. A stored pair can go stale — a choice
removed from the allowlist, or two clients writing the same character — and the composer
still needs a usable pair. On collision the command sigil wins because it is the older,
more load-bearing of the two.

In the settings UI, picking the character the _other_ menu already uses swaps the two
rather than rejecting the choice.

The sigils configure autocomplete and presentation, not the provider protocol. Choosing
an option writes provider-compatible `/name` into the draft; the web mirror displays the
active configured sigil over that one-character canonical prefix. If the catalog has not
loaded, there is nothing to choose and submission preserves the user's exact text.

## Web: a mirror layer

`token-highlight.web.tsx`. A div sits behind the `<textarea>` rendering the same string
with pills. The textarea paints its own text transparent (`color: transparent` plus
`caretColor`) so the mirror is what the user reads, while the textarea keeps the caret,
selection, IME and the native context menu.

**THE INVARIANT: the mirror must lay out character-for-character identically to the
textarea.** Three consequences, all load-bearing:

1. Every property affecting line breaking is _copied from the live textarea_ via
   `getComputedStyle` (`COPIED_STYLES`), not restated in a stylesheet. The composer's
   font size is user-configurable and its width changes with panel layout; a stylesheet
   drifts, a copy cannot.
2. **A pill may not change the advance width of the text it decorates.** Horizontal
   padding is cancelled by an equal negative margin, so the pill grows visually around
   the glyphs without moving them. Never change one without the other.
3. **The display sigil is not as wide as the canonical slash it stands in for.** The UI
   font is proportional — `$` runs 3.2px wider than `/` at the default size — so an
   uncorrected substitution shifts every glyph after the token to the right, leaving the
   caret behind the text it belongs to, and can wrap the mirror onto a line the textarea
   does not have. `useSigilAdvanceCorrections` measures both characters inside the mirror
   (the font is user-configurable, so a hardcoded table would be wrong) and hands the
   difference back as margins, half on each side, keeping the sigil centred on the slot
   the slash occupies. Only the sigil itself overhangs; every other glyph lands exactly
   where the textarea puts it.

Consequences (2) and (3) are why the pill shows the token text under a one-character
sigil rather than an icon or a prettified display name: correcting a whole substituted
string means squeezing glyphs, not nudging one. Getting icons and display names on web
means replacing the textarea with a contenteditable editor; it cannot be done with a
mirror.

### Colors

Fill, border and text all derive from **`accentBright`**, not `accent`. `accent`
(`#20744A`) is the dark fill green; a tint of it under foreground-colored text goes
muddy on dark and harsh on light. `accentBright` is the theme's accent-as-text token —
the same one markdown links use — and reads in both themes.

Colors reach this component as props via `withUnistyles` (alternative 3 in
[unistyles.md](unistyles.md)), because it draws raw DOM rather than `style`-tracked RN
views. **Do not reach for `var(--colors-*)`:** nothing in Unistyles emits those
variables. `install-web-scrollbar-styles.web.ts` still references
`var(--colors-scrollbar-handle)`, which therefore resolves to nothing — treat that as a
bug to fix, not a pattern to copy.

Two smaller details that are easy to lose:

- The textarea sits _above_ the mirror, so its selection rectangle would paint over the
  mirror's glyphs. A translucent `::selection` (installed once, scoped to
  `[data-composer-tokenized]`) lets them read through. Without it, selecting tokenised
  text blanks it out.
- A trailing newline collapses unless something follows it, which would shift the
  mirror's last line relative to the textarea's. Hence the zero-width span.

`e2e/browser/composer-tokens.spec.ts` guards alignment by measuring the mirror's last
line against a probe holding the canonical draft in the same inherited font. To check by
eye after touching any of this: render the same string in both layers with the
textarea's text a visible color instead of transparent. The two sets of glyphs must
coincide exactly, and the wrap point must match, including when a token straddles the
wrap boundary.

## Native: plain text by design

`token-highlight.native.tsx` is intentionally a no-op. Android React Native throws when
a `TextInput` receives both a controlled `value` and children; iOS ignores those
children. Dropping `value` would sacrifice the controlled-input contract and make
selection, dictation and external draft updates unreliable.

A native mirror would also have to reproduce the input's font metrics, wrapping and
scroll exactly to keep the caret on the glyphs. Native pills therefore require a real
attributed-input implementation or custom text view. Until then, native keeps the
existing controlled plain-text path and shows the canonical slash after an autocomplete
selection.

## The web renderer opts out when there is no token

Web keeps rendering through the plain textarea instead of the mirror when the draft has
no token. `ComposerTokenHighlightLayer` takes an `enabled` prop and installs no
observers in that common path.

## Sent messages: canonical data, configured presentation

Submitted and queued text use the provider-compatible `/name` form. Sent-message
bubbles recover token type from position — a leading slash is a command and a slash
after whitespace is a skill — then display the token with the current configured
command or skill sigil. The copy action, rewind, persistence and provider history still
use the canonical text; only the rendered `Text` spans change.

Unlike the controlled composer input, a sent message can safely use nested React Native
`Text` spans, so pills render on web, Electron, iOS and Android without a mirror layer.
Changing trigger settings consequently updates the presentation of existing history
without rewriting that history.
