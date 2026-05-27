# Notifications

Paseo sends agent attention notifications through mobile push tokens by default. The daemon can also run an optional post-hook for the same external notification decisions.

## Agent Attention Hook

`agentAttention` is a fire-and-forget post-hook. Paseo runs it only when the existing push notification policy decides an external notification should be sent. Hook failures, non-zero exits, and timeouts are logged but do not block Expo push delivery or agent lifecycle handling.

Configure it in `$PASEO_HOME/config.json`:

```json
{
  "version": 1,
  "notifications": {
    "hooks": {
      "agentAttention": {
        "enabled": true,
        "command": ["node", "/path/to/paseo-agent-attention-hook.mjs"],
        "timeoutMs": 5000
      }
    }
  }
}
```

The hook receives one JSON object on stdin:

```json
{
  "agentId": "agent_123",
  "provider": "codex",
  "reason": "permission",
  "notification": {
    "title": "Agent needs permission",
    "body": "Need input - Choose an option",
    "data": {
      "serverId": "srv_123",
      "agentId": "agent_123",
      "reason": "permission"
    }
  }
}
```

`reason` is one of `finished`, `permission`, or `error`. The current external push policy does not send `error` notifications, so the hook normally receives `finished` and `permission` events. Permission events cover tool approvals, plan approvals, questions, mode changes, and other provider-specific permission prompts.

## ServerChan Example

ServerChan can be implemented in userland with a hook script instead of adding provider-specific code to Paseo. Keep the send key in an environment variable rather than in `config.json`.

```js
const input = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(JSON.parse(data)));
  process.stdin.on("error", reject);
});

const sendKey = process.env.PASEO_SERVERCHAN_SENDKEY;
if (!sendKey) {
  throw new Error("PASEO_SERVERCHAN_SENDKEY is required");
}

const turboMatch = sendKey.match(/^sctp(\d+)t/i);
const endpoint = turboMatch
  ? `https://${turboMatch[1]}.push.ft07.com/send/${sendKey}.send`
  : `https://sctapi.ftqq.com/${sendKey}.send`;

const body = new URLSearchParams({
  title: input.notification.title,
  desp: input.notification.body,
});

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});

if (!response.ok) {
  throw new Error(`ServerChan request failed with ${response.status}`);
}
```
