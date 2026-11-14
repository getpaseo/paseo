## Transform and render timeline items

Timeline transformers and renderers are client contributions. A transformer selects one built-in `AgentTimelineItem.type`, inspects the item, and returns zero or more versioned plugin items. `undefined` keeps the source item, `items` replaces it, `[]` removes it. A renderer draws one `kind` and `version` after validating `data` with its Zod schema.

```ts
client.addTimelineTransformer({
  id: "inline-thinking",
  query: { itemType: "reasoning" },
  transform: ({ item, phase }) => ({
    items: [
      { type: "plugin", kind: "inline-thinking", version: 1, data: { text: item.text, phase } },
    ],
  }),
});
client.addTimelineRenderer({
  kind: "inline-thinking",
  version: 1,
  schema: z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) }),
  Component: InlineThinking,
});
```

Transformers run while the render model is built, on fetched history and on every live update, so `phase` is `"streaming"` for a loading thought or running tool call. Identity comes from the source item, so a streaming item keeps its mounted component; set an output `id` when one source explodes into several items. Transformers must be synchronous and deterministic, `data` must be JSON, and a transformer that throws is logged and skipped. Render `<StreamedText text={text} phase={phase} />` from `@getpaseo/plugin/client/ui` for paced assistant text; use its `style` prop to customize text appearance. `plugin-examples/inline-thinking` replaces the thinking row with inline text; `plugin-examples/timeline-items` replaces a todo tool call with a task card.

## Append a timeline row from the daemon

A server handler can push a plugin-owned row into any agent timeline. The same renderer registration draws it.

```ts
server.handle(publishReview, async ({ agentId, verdict }, { paseo }) => {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: "review",
    kind: "review-result",
    version: 1,
    data: { verdict },
  });
  return {};
});
```

The daemon stamps `pluginId` from the plugin session, so only plugin code can call this. Re-appending with the same `id` replaces the earlier row live and on refetch, which is how a plugin updates a row. `data` is capped at 64 KiB serialized and rejected above that. Rows live in the daemon's in-memory timeline and survive scroll, refetch, and reconnect, but not a daemon restart. A row whose plugin is missing renders an unavailable placeholder. Hosts advertise support through `server_info.features.pluginTimelineItems`.
