---
id: a1e6eec8
title: Fix inverted chat spacing
status: done
deps: []
created: 2026-01-11T13:15:47.498Z
---


## Notes

**2026-01-11T13:15:52.529Z**

User requires inverted FlatList spacing: only marginBottom on wrapper in agent-stream-view, child components zero margins when disableOuterSpacing. marginBottom based on next item: 4px if same type group (user-user, tool/thought-tool/thought), else 16px; first item marginBottom 0.

**2026-01-11T13:39:59.545Z**

Fix spacing by computing inverted-list gap from the item above (index + 1) instead of below; index 0 is bottom, topmost item gets 0 marginBottom.

**2026-01-11T13:40:18.974Z**

Adjusted inverted list spacing to compute marginBottom based on the item above (index + 1) so gaps match 4px/16px rules; ran typecheck.
