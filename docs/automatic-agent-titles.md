# Initial agent titles

When no explicit title is supplied, initial naming uses the first nonempty prompt line with whitespace normalized. Titles of at most 60 UTF-16 code units stay unchanged. Longer lines reserve one unit for an ellipsis and end at the last complete whitespace-delimited word that fits.

If no complete first token fits in the remaining 59-unit budget, naming uses a bounded prefix plus ellipsis. A trailing high surrogate is removed so an emoji surrogate pair is not split. Languages without spaces and long identifiers use this same bounded-token fallback; this is not linguistic word segmentation.

Explicit titles retain their current precedence and are not shortened by this provisional naming rule. This change performs no migration or scan of existing agents. The first-message path still names only agents without a stored title and without a prior user message. Previously shortened titles remain unchanged.

The helper is also used for provisional workspace, initial-agent and scheduled-agent naming. Those callers receive the same bounded, omission-marked result. There is no protocol or maximum-title schema change.

Verification: `npm run test:unit -- --maxWorkers=1 src/server/session.create-agent-title.test.ts` from `packages/server`. Coverage includes the reported mid-word cutoff, exact cap, 59/60/61-unit first tokens followed by text, a surrogate pair at the cutoff, whitespace normalization, empty input and manual-title preservation.

This source change needs adoption in the Paseo daemon to affect future names. A plugin update alone cannot change it. It does not authorize changing a running installation or bulk-rewriting titles.
