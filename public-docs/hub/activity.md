---
title: Hub activity
description: Inspect trigger runs, distinguish filtered events from unrouted ones, and debug a trigger that did not run.
nav: Activity
order: 75
category: Hub
---

# Hub activity

Hub records every accepted event, whether or not it started a run. Use **Activity** and **Integrations** to inspect deliveries and debug triggers.

## Where to look

**Activity** lists recent trigger runs for the organization. Each row shows the trigger, provider, source, status, and when Hub received the event.

**Integrations → Known unrouted events** shows the 50 most recent accepted provider events that did not start a run. Hub records one of four reasons:

| Reason                      | Meaning                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `no_project_route`          | No enabled route matched the event's integration or resource |
| `no_trigger_for_source`     | No enabled trigger handles that event source                 |
| `trigger_filters_rejected`  | A trigger matched the source, but its filters rejected it    |
| `configuration_unavailable` | A referenced trigger or integration could not be resolved    |

## Nothing happened when an event arrived

Check these items in order:

1. Open **Activity**. If the event is missing there, check **Integrations → Known unrouted events** and read the recorded reason.
2. If the event is missing from both views, use the provider delivery log to see whether Hub accepted it. For GitHub, open **App → Advanced → Recent Deliveries**. If the provider sent no delivery, make sure that the integration subscribes to the event type.
3. Verify `from_users`. GitHub uses login names, while Linear, Slack, and Discord use user IDs ([Linear](/docs/hub/triggers/linear#filters-and-linear-uuids), [Slack](/docs/hub/triggers/slack#find-your-slack-ids), [Discord](/docs/hub/triggers/discord#find-your-discord-ids)).
4. Verify text filters (`contains`, `pattern`, and GitHub `exclude_contains`). On Slack and Discord, the message must mention the bot and any `pattern` must follow the mention.
5. Verify that the trigger is enabled under **Triggers**.
6. Verify that the target daemon is connected under **Daemons** and holds the `hub.execute` permission.
7. If the run started and stopped early, compare its duration against `max_runtime`, `idle_timeout`, and `startup_timeout`.
8. If the run finished without posting back, check `run.prompt`. The prompt must tell the agent to call `reply` (or `slack_post` / `discord_post`) and `finish_execution`.

## Webhook and schedule runs

Runs started by inbound webhooks appear in **Activity** under `webhook.received`. If an HTTP `POST` returns an error status (`400`, `401`, `403`, `409`, `413`, or `429`), see [Inbound webhooks](/docs/hub/triggers/webhooks#request-limits-and-responses).

Scheduled runs appear in **Activity** under `schedule.tick`. While a scheduled run is still active, Hub skips newly due occurrences for that trigger until the active run completes or fails.
