---
id: pas-id4i
status: closed
deps: []
links: []
created: 2026-04-28T14:09:42Z
type: task
priority: 3
assignee: Ryan Swift
tags: [app, autocomplete, backlog]
---

# Backlog: improve slash command autocomplete ranking

Paseo slash command autocomplete currently behaves differently from OpenCode for exact short commands like `/q`. `/q` and `/exit` are present in the app, but matching/selection can still feel wrong because the list is rendered above the composer and selection starts from the visually bottom row.

Observed behavior:

- Typing `/q` shows the local `/q` command, but nearby provider commands can still affect the selected/autocomplete target.
- The list appears to search/select from the bottom upward.
- In terminal OpenCode, `/q` appears to resolve immediately as the exact quit command/alias.

Likely mechanical cause:

- Autocomplete options rendered above the input are reversed for presentation.
- The fallback selected index for above-input popovers is `itemCount - 1` so the bottom row is selected.
- Provider command matching uses substring includes, not exact/prefix-aware ranking.
- Local commands are inserted before provider commands, but the combined local+provider list is not ranked and then presented as one ordered list.

Preferred fix direction:

- Separate ranking from presentation.
- Rank logical command matches first: exact match, then prefix match, then substring match.
- Include local commands and provider commands in the same ranked logical list.
- Apply above-input presentation ordering after ranking, so the best-ranked command appears nearest the composer and is the selected fallback.
- Avoid a hardcoded `/q` bypass; make this a general command matching improvement.

Acceptance criteria:

- Typing `/q` selects the local `/q` command by default.
- Typing `/exit` selects the local `/exit` command by default.
- Provider commands still appear and remain selectable.
- Above-input visual ordering and keyboard navigation remain intuitive.

Implementation notes:

- Logical command ranking now runs before above-input presentation ordering.
- Ranking is exact, then prefix, then substring.
- Local commands and provider commands share one ranked list, with local commands winning ties.
- Above-input presentation reverses the ranked list so the best logical match is nearest the composer and selected by the existing fallback index.
