---
title: Hub activity
description: Read what Hub did with an event, tell a filtered event from an unrouted one, and debug a trigger that did nothing.
nav: Activity
order: 72
category: Hub
---

# Hub activity

Every event Hub accepts is recorded, whether or not it ran anything. That record is how you debug a trigger.

## Where to look

**Project → Activity** lists routed trigger runs and their execution state.

**Connections → Known unrouted events** is the organization-level view of accepted provider events that did not start a configured trigger. Hub records one of four bounded reasons:

| Reason                      | Meaning                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `no_project_route`          | No project route is configured for the event                 |
| `no_trigger_for_source`     | No configured trigger handles that event source              |
| `trigger_filters_rejected`  | A trigger handles the source, but its filters rejected it    |
| `configuration_unavailable` | A relevant configuration or connection could not be resolved |

## Nothing happened when I mentioned the bot

Work down this list.

1. **Is the event in the project's Activity?** If not, check **Connections → Known unrouted events** and use its reason to distinguish routing, source, filter, and configuration failures.
2. **Is the event anywhere at all?** If not, the event never reached Hub. Check the provider's own delivery log: GitHub's App → Advanced → Recent Deliveries, or Slack's Event Subscriptions page. Then check that the app is subscribed to that event type.
3. **Is your user in `from_users`?** This is the most common cause. GitHub uses your login; Slack and Discord use the user ID, not the display name.
4. **Did the invocation match?** On GitHub, `contains` must appear in the comment body. On Slack and Discord the bot must be mentioned, and `pattern` or its legacy `contains` alias must prefix the text after the mention.
5. **Is the configuration you think is active actually active?** The Configuration tab shows the active revision and the last sync attempt. A failed push leaves the old revision serving.
6. **Is the daemon connected?** An offline daemon fails dispatch with `daemon_not_connected`.
7. **Did it run and stop early?** Compare the execution with the step's authored `idle_timeout` and `max_runtime`, and the workflow's `max_runtime`. All three limits are explicit in the workflow.
8. **Did it run, but deliver nothing?** Check the step's prompt. An agent that is not told to call `hub.reply` and `hub.finish_execution` can answer in its own transcript and never report back. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).

## Sync failures

The Configuration tab shows the latest sync state:

| State                   | What to do                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| Fetch failed            | The file is missing at that commit, or the App can't read the repository |
| Invalid                 | Validation failed, or the config names something unreachable             |
| Superseded push ignored | A newer commit already moved the branch head; nothing is wrong           |

"Names something unreachable" is usually a repository the installation doesn't cover, a daemon that was renamed, or a connection slug that no longer exists. See [How Hub works](/docs/hub/concepts).

## Nothing is retried

Hub does not queue events. A dispatch that fails because the daemon was offline stays failed, so trigger it again once the daemon is back.
