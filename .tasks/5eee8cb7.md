---
id: 5eee8cb7
title: Fix inverted FlatList spacing
status: done
deps: []
created: 2026-01-11T12:31:33.219Z
---


## Notes

**2026-01-11T12:31:44.968Z**

Need consistent 16px gaps between different content types in inverted FlatList; 4px gaps within groups (user messages, tool calls). Inverted list: marginBottom renders above, marginTop below. Check message.tsx + agent-stream-view.tsx, fix spacing, run typecheck.

**2026-01-11T12:45:33.340Z**

Centralized chat item spacing in AgentStreamView with inverted-list gap calculation (4px within user/tool groups, 16px otherwise). Added disableOuterSpacing prop to message components to keep other views unchanged. Typecheck passed.
