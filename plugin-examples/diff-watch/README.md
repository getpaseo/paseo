# Diff watch plugin example

A workspace panel subscribes to a daemon-side watcher and lists the files that differ from `HEAD`,
updating as files change.

```bash
paseo plugin add /absolute/path/to/paseo/plugin-examples/diff-watch
```

- `shared/diff.ts` defines the `diff.watch` subscription contract.
- `index.server.ts` handles it: an async handler that loops until the subscriber leaves, pushing
  the file list whenever it changes. A git failure rejects the handler and closes the subscription
  with that error.
- `client/diff-panel.tsx` calls `useSubscription` and renders the latest list.
