---
title: Notion for Hub
description: Connect an internal Notion integration and verify native webhook deliveries.
nav: Notion app
order: 78
category: Hub
---

# Notion for Hub

Hub supports one internal Notion integration per instance. It verifies a workspace and bot identity, saves a connection for the active Hub organization, and receives signed native webhook events. Task triggers, agent execution, context loading, and result writeback are not available yet.

## Connect the integration

Open Hub at its public HTTPS address and sign in as the instance operator. Select the organization that should own the connection, then open **Apps → Notion**.

1. Create an internal connection in the [Notion developer portal](https://www.notion.so/profile/integrations).
2. Enable **Read content**, **Read comments**, **Update content**, and **Insert comments**.
3. Share a dedicated verification page with the connection. Share any other content the integration should be able to access separately in Notion.
4. Enter the integration ID from its developer settings, the internal integration token, and the verification page ID in Hub. Page IDs may include or omit UUID separators.
5. Choose **Verify permissions and connect**.

Verification reads the bot identity, page, content, and comments. It sends an empty property update and adds a verification comment to the dedicated page. Each attempt may add another comment. Do not use a production task as the verification page unless these writes are acceptable.

Hub displays the verified workspace and bot IDs. The integration ID is supplied by the operator and checked against subsequent signed webhook deliveries. The connection cannot be transferred to another Hub organization or integration by replacing its credentials; disconnect it first.

Notion controls content access. Configuring a data source or workflow in Hub does not grant additional access in Notion. Hub keeps the token in its credential storage and does not expose it through ordinary configuration or pass it to an agent.

## Verify the webhook subscription

REST requests and the subscription version are fixed to **2026-03-11**.

1. In **Apps → Notion → Notion webhook**, choose **Prepare verification address**.
2. Copy the generated HTTPS URL into the integration's **Webhooks** settings in Notion. Select `page.properties_updated` and API version `2026-03-11`.
3. Create the subscription. Notion sends its verification challenge to Hub.
4. Choose **Check verification** in Hub. Copy the verification token into Notion to complete its subscription verification.
5. Copy that subscription's ID from Notion into Hub and choose **Bind verified subscription**. Confirm the subscription is active in Notion.

The temporary verification address expires after ten minutes. If it expires, prepare another address and repeat the subscription setup. The saved subscription continues using its configured URL after verification; the temporary parameter only controls challenge reception. It is not event authentication.

Challenges never start runs or replace an active webhook secret. Preparing a replacement leaves the active subscription usable until an operator explicitly binds the replacement. The verification token is shown only through the protected setup action; it is not part of ordinary readable configuration.

## Check delivery and maintain the connection

Change a property on a page shared with the integration. Hub checks `X-Notion-Signature` against the original request bytes and verifies the workspace, integration, subscription, and active connection before recording `page.properties_updated` deliveries. Events appear in the existing activity records with no matching trigger. Delayed retries are allowed, and repeated deliveries of the same event reuse the existing receipt. Other correctly authenticated event types are ignored.

Use **Replace credentials** in Apps to verify a rotated token. Failed verification or activation leaves the previously working Hub configuration intact. Correct the token, capabilities, page sharing, or reported conflict and try again. A rate limit or unavailable Notion service is reported without treating the check as successful; retry after the service recovers.

Use the organization's **Connections** page to disconnect Notion. This removes the local binding and its webhook secrets, immediately stopping event admission. It does not delete the integration or subscription in Notion. Disable those in the Notion portal when they are no longer needed. Reconnecting requires setting up and binding the webhook again.

Keep tokens, verification secrets, real workspace IDs, and private operational notes outside public repositories. Examples and deployment instructions need only placeholder IDs; no OAuth credentials or daemon protocol changes are required.
