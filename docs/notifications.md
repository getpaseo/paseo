# Notifications

Notification settings belong in `daemon.notifications` in `$PASEO_HOME/config.json`, or in the daemon's environment. They take effect at daemon startup. The desktop-managed daemon reads its own configuration file; desktop management clears daemon-setting environment variables from managed launches. Use the file for that deployment. See [development](development.md) for checkout-local and packaged daemon homes.

## Routing

In-app attention keeps the existing presence cascade: a recently active client viewing the target suppresses its banner; otherwise the most recently active client gets the banner. Remote delivery has a separate policy:

| Mode               | Expo push                                                                                                                                                | ntfy                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `legacy` (default) | Suppressed when any notification-owning client was active within 180 seconds                                                                             | Receives enabled events independently of presence |
| `always_push`      | Every registered device receives enabled events, including while the desktop is active or viewing that agent                                             | Receives enabled events                           |
| `smart`            | Suppresses only the token belonging to a mobile client visibly viewing that target, with both activity and a received heartbeat less than 30 seconds old | Receives enabled events                           |

A desktop heartbeat never suppresses Expo in `smart` or `always_push`. Backgrounded and disconnected mobile clients remain eligible. Smart routing falls back to sending when a client has no matching registered token. A missed background heartbeat can leave a viewing phone suppressed for up to 30 seconds in smart mode; use `always_push` when you want every event remotely.

Providers are `expo` (default), `ntfy`, or `both`. Each provider has a separate delivery worker. ntfy requires no Expo registration. Disabling remote notifications leaves in-app attention operational. Agent errors use the existing lifecycle transition event; repeated state updates do not generate repeated errors. Permission requests use the existing pending-permission batch semantics. Internal and delegated agents retain their existing attention behavior. Terminal completion and `needs_input` events are supported; there is no separate terminal-error event in the current attention API.

## MacBook with self-hosted ntfy

Merge this into `~/.paseo/config.json` for the packaged Mac desktop daemon. Keep the file readable only by your account (`chmod 600 ~/.paseo/config.json`). Replace the example URL and token with your own values.

```json
{
  "daemon": {
    "notifications": {
      "enabled": true,
      "mode": "always_push",
      "provider": "both",
      "onFinish": true,
      "onError": true,
      "onPermission": true,
      "onTerminal": true,
      "includePreviews": false,
      "ntfy": {
        "url": "https://ntfy.example.com",
        "topic": "paseo-agents",
        "token": "REPLACE_WITH_PRIVATE_PUBLISH_TOKEN"
      }
    }
  }
}
```

Use `provider: "ntfy"` for ntfy only, or `provider: "expo"` for Expo only. Restart the daemon through your normal deployment controls after updating settings; first account for running agents.

On Android, install the ntfy app, add your server, authenticate with a token that can read the topic, and subscribe to `paseo-agents`. Give the daemon's token publish access to that topic. Enforce topic access control on your ntfy server; a topic name alone provides no confidentiality. See [ntfy authentication](https://docs.ntfy.sh/publish/#authentication) and [Android subscription settings](https://docs.ntfy.sh/subscribe/phone/).

Headless and container daemons also accept:

```dotenv
PASEO_NOTIFICATIONS_ENABLED=true
PASEO_NOTIFICATION_MODE=always_push
PASEO_NOTIFICATION_PROVIDER=both
PASEO_NTFY_URL=https://ntfy.example.com
PASEO_NTFY_TOPIC=paseo-agents
PASEO_NTFY_TOKEN=REPLACE_WITH_PRIVATE_PUBLISH_TOKEN
PASEO_NOTIFY_ON_FINISH=true
PASEO_NOTIFY_ON_ERROR=true
PASEO_NOTIFY_ON_PERMISSION=true
PASEO_NOTIFY_ON_TERMINAL=true
PASEO_NOTIFICATION_PREVIEWS=false
```

Keep environment files private and out of Git. For remote Linux agents, configure each daemon independently. Events include the daemon's server ID; deduplication never combines different agents or servers. The ntfy body includes available project/workspace labels, provider, agent or terminal ID, event type and timestamp.

## Settings and defaults

Environment settings override their corresponding file settings.

| Environment                       | `daemon.notifications` field | Default                                          |
| --------------------------------- | ---------------------------- | ------------------------------------------------ |
| `PASEO_NOTIFICATIONS_ENABLED`     | `enabled`                    | `true`                                           |
| `PASEO_NOTIFICATION_MODE`         | `mode`                       | `legacy`                                         |
| `PASEO_NOTIFICATION_PROVIDER`     | `provider`                   | `expo`                                           |
| `PASEO_NOTIFY_ON_FINISH`          | `onFinish`                   | `true`                                           |
| `PASEO_NOTIFY_ON_ERROR`           | `onError`                    | `false` in legacy, `true` in other modes         |
| `PASEO_NOTIFY_ON_PERMISSION`      | `onPermission`               | `true`                                           |
| `PASEO_NOTIFY_ON_TERMINAL`        | `onTerminal`                 | `true`                                           |
| `PASEO_NOTIFICATION_PREVIEWS`     | `includePreviews`            | `false`                                          |
| `PASEO_PUSH_TOKEN_RETENTION_DAYS` | `tokenRetentionDays`         | `180`, allowed range 7–3650                      |
| `PASEO_NTFY_URL`                  | `ntfy.url`                   | Required when ntfy is enabled                    |
| `PASEO_NTFY_TOPIC`                | `ntfy.topic`                 | Required, 1–64 ASCII letters, digits, `_` or `-` |
| `PASEO_NTFY_TOKEN`                | `ntfy.token`                 | Required when ntfy is enabled                    |
| `PASEO_NTFY_ALLOW_HTTP`           | `ntfy.allowHttp`             | `false`                                          |
| `PASEO_NTFY_PRIORITY_FINISH`      | `ntfy.priorities.finished`   | `default`                                        |
| `PASEO_NTFY_PRIORITY_ERROR`       | `ntfy.priorities.error`      | `high`                                           |
| `PASEO_NTFY_PRIORITY_PERMISSION`  | `ntfy.priorities.permission` | `urgent`                                         |
| `PASEO_NTFY_PRIORITY_TERMINAL`    | `ntfy.priorities.terminal`   | `default`                                        |

Priorities accept `min`, `low`, `default`, `high`, or `urgent`. Both providers use the same proxy-aware HTTP transport, honoring `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and lowercase variants through Undici. Lowercase variants take precedence. This does not depend on Node's optional global fetch proxy flag. Requests time out after 10 seconds, including response parsing, and do not follow redirects.

HTTPS is required for ntfy. Set `allowHttp: true` only for a network you explicitly trust. URL credentials, query strings and fragments are rejected. Credentials stay on the daemon and are absent from the public mutable-configuration API. Notification delivery to ntfy is outside the relay's encrypted transport: ntfy and topic readers can read the message.

Assistant previews are disabled by default to avoid exporting coding-agent content. Enabling them includes up to 220 characters of the last assistant message; secrets in assistant prose cannot be identified reliably. Permission tool arguments and provider metadata are never included. Titles and context labels are bounded and sanitized; UTF-8 titles use ntfy's JSON publishing API rather than HTTP headers. Existing Expo routing data keeps its server/workspace/agent or terminal IDs. ntfy has no clickable agent link: the current app has no verified universal agent URL that works independently of private host connectivity.

## Expo devices and token retention

Open Paseo once on each Android or iOS device, grant notification permission and connect to each daemon you want notifications from. Registration is stored per daemon, so a relay connection is not required when the daemon submits a push. Expo's FCM/APNs delivery operates independently of foreground WebSocket presence. See [Expo delivery documentation](https://docs.expo.dev/push-notifications/sending-notifications/).

Tokens survive daemon restarts and are retained for about 180 days after renewal by default. Renewal writes are coalesced to at most once a day. Closing the mobile app for 48 hours does not remove its subscription. Existing 48-hour records migrate using their original renewal time; tokens already deleted by an old daemon require one new registration. Connecting or a native token-change event registers the replacement and revokes the old cached token where revocation is supported. Removing a daemon from the mobile app explicitly revokes the subscription when connected; offline removal cannot immediately reach the daemon.

Only `DeviceNotRegistered` permanently invalidates a device. Expo's `InvalidCredentials` indicates a project credential problem and leaves device registrations intact. Unused subscriptions age out according to retention. The registry is capped at 1000 devices. Token and queue files use private atomic writes (0600 files, 0700 parent directories on POSIX).

## Delivery and diagnostics

Each provider queue holds at most 1024 entries and spaces HTTP attempts at least 200 ms apart. Pending sends, Expo receipt IDs and terminal delivery outcomes persist across restarts. Individual persisted payloads are capped at 8 KiB. Completed entries deduplicate event retransmissions for up to 24 hours, subject to the queue bound. Retries use exponential backoff with jitter, respect `Retry-After`, and stop after five attempts per send/receipt phase. HTTP 429, 5xx and network/timeouts retry; authentication errors and malformed requests fail permanently. An event expires after 24 hours. When ntfy's configured server or topic changes, queued messages for the previous destination are suppressed.

Expo checks receipts after 15 minutes. A missing receipt is checked again with bounded retries. `accepted` means the service received a submission. `delivered_to_push_provider` means Expo reports submission to FCM/APNs. Neither proves that Android displayed the notification. ntfy acceptance also does not prove phone delivery.

Read `$PASEO_HOME/daemon.log`. Look for these messages and their `eventId`, `provider`, `mode`, `type`, and identity fields:

- `Notification dispatched` / `Notification suppressed`: provider selection, presence and suppression reason.
- `No eligible registered push tokens`: no Expo devices remain eligible; `registeredDevices` distinguishes missing registration from smart suppression.
- `Notification delivery retry`: failure category, HTTP status, retry count and next delay.
- `Expo push accepted`: persisted ticket receipt tracking starts.
- `Expo receipt failure`: FCM/APNs or Expo reported a downstream error.
- `ntfy notification accepted`: submission succeeded.
- `Notification permanent delivery failure`: retry budget, configuration rejection, expiry or capacity failure.
- `Notification queue unavailable`: filesystem persistence failure.

Enable debug logs for individual attempts and device counts. Logs exclude bearer/device tokens and provider error bodies. Queues contain notification content and Expo tokens on disk; protect daemon backups as you protect the configuration file.

For missed notifications, first verify mode/provider/event flags, device registration, and the event's logs. Then verify proxy reachability, ntfy topic ACLs or Expo project credentials. Finally check Android permission, notification-channel and ntfy background/battery settings on the device. Force-stopping an app and OS/vendor restrictions can prevent display even after successful submission. Use a physical-phone test to distinguish this from daemon routing.

The queue provides bounded at-least-once submission. A timeout or crash after remote acceptance but before a durable acknowledgement can cause duplicates; neither provider supplies an end-to-end idempotency guarantee. Failed queue entries retain their outcome in logs and the bounded queue. There is no automatic dead-letter replay or UI for queue inspection.
