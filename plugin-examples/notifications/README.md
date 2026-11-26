# Notifications plugin example

Sends notifications from a server lifecycle hook (`agent.turn.after`) and a plugin RPC (`alerts.send`),
and handles notification taps on the client with `client.onNotificationOpen`.

```bash
paseo plugin add /absolute/path/to/paseo/plugin-examples/notifications
```

- `index.server.ts` calls `server.notifications.send` with a deduplication `key`, a declarative
  `open` fallback target, and structured `data`.
- `index.client.tsx` registers the `alert` screen and a `client.onNotificationOpen` callback that
  navigates to an agent or opens the `alert` screen with the notification's payload.
