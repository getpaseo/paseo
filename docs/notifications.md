# Notifications

Paseo tells you an agent needs attention for three reasons — `finished`, `permission`, or `error` — through two independent channels:

- **In-app banner** — a WebSocket notification to a specific connected client, rendered in the app.
- **Remote push** — an Expo push to your phone via APNs/FCM, shown even when the app is backgrounded.

The daemon decides each one separately. In-app routing chooses the recipient client; `daemon.notifications.policy` chooses when the remote push goes out.

## Default behavior

By default (`policy: "smart"`) the daemon sends the remote push only when **no client has been active in the last 180 seconds**. "Active" is generous — on Electron, system-wide idle time counts as activity, so a desktop client stays "present" while you work in any other application.

So if any client was active recently, the presence window treats someone as watching and suppresses the phone push. The phone is only pinged once every client has been idle for 180 seconds.

The most common flow trips this: you send a message on your phone, background the app, and the agent finishes — or asks for permission — within three minutes. Your phone counts as "present" (you just used it), so the push is suppressed, even though a backgrounded phone can't render the in-app banner either. You get no notification at all.

## Policy

Set `policy` under `daemon.notifications` in `~/.paseo/config.json`:

```json
{
  "daemon": {
    "notifications": { "policy": "always" }
  }
}
```

| `policy`          | Sends remote push when...                              |
| ----------------- | ------------------------------------------------------ |
| `smart` (default) | No client has been active in the last 180s             |
| `unwatched`       | No present, app-visible client is focused on the agent |
| `always`          | The attention reason is eligible (not `error`)         |

- `smart` only pushes when everyone is away.
- `unwatched` pushes whenever nobody is literally watching the agent — a backgrounded phone or an active desktop you're not looking at still triggers the push, while someone actually focused on the agent suppresses it.
- `always` pushes even while someone is watching.

Every mode keeps in-app routing unchanged and never pushes for an `error` reason. There is no cost difference: the push goes out over exp.host to APNs/FCM, which do not charge per push.
