---
title: "Privacy Policy"
description: "What stays on your machines, what the encrypted relay can see, and what Paseo Hub stores."
lastUpdated: "2026-08-29"
---

Paseo is local-first. Installing or using the open-source software does not send us your code, prompts, files, terminal output, or agent conversations. This policy explains the separate data boundaries for local Paseo, the optional official relay, the hosted Paseo Hub, and paseo.sh.

## Who is responsible

**Mohamed Boudra Ziani**, operating as Paseo\
NIF/VAT ID: ES26617095T\
Roc Boronat 48, Bajos 2\
08005 Barcelona, Spain\
Email: [hello@moboudra.com](mailto:hello@moboudra.com)

Mohamed Boudra Ziani is the data controller for personal data processed through the official Paseo website, relay, and hosted Hub. Independently self-hosted daemons, Hubs, and relays are controlled by their operators and are not covered by this policy.

## Local Paseo apps and daemons

Paseo runs on your machines. It does not send us analytics, telemetry, advertising identifiers, or crash reports.

Packaged desktop apps check GitHub Releases for updates. GitHub receives the ordinary network information needed to answer that request under its own privacy policy.

Agents such as Claude Code, Codex, and OpenCode communicate with their providers using credentials on your machine. Paseo does not manage or intercept those provider API calls.

## The official relay

The relay is optional. To connect your client and daemon, it processes:

- IP addresses and connection timing
- Session identifiers and public handshake keys
- Message sizes and aggregate bandwidth
- Temporary connection and routing state

Your client and daemon encrypt application traffic end-to-end with NaCl box encryption. The relay carries ciphertext and cannot read your code, prompts, terminal output, or agent conversations. Payloads exist in relay memory only while being forwarded. We do not store message contents. Infrastructure may retain limited operational logs and aggregate metrics for security, capacity planning, and troubleshooting.

## Paseo Hub

When you create or use a hosted Hub account, we process:

- Your name, email, account credentials, sessions, IP address, and user agent
- Your organization, members, roles, invitations, and daemon registrations
- Identifiers and credentials for services you connect
- Webhook events, messages, comments, attachment metadata, and related context received from those services
- Workflow configurations, trigger inputs, outputs, execution state, activity, and audit records
- Stripe customer identifiers and subscription information needed to provide access

Your repositories, local files, and agent-provider credentials remain on your infrastructure unless a workflow explicitly sends information to Hub or a connected service. Hub does not provide AI inference.

## Who controls workflow data

Paseo controls account, billing, security, and service-operation data. When an organization uses Hub to process personal data in its workflows, that organization decides why the data is processed and Paseo processes it on the organization's behalf.

## Why we process data

We process data to:

- Provide accounts, Hub workflows, relay connectivity, billing, and support
- Authenticate users, daemons, and connected services
- Prevent abuse and protect the services
- Maintain operational and audit records
- Meet accounting, tax, and other legal obligations

The legal bases are performance of our contract with you, our legitimate interests in operating and protecting the services, and compliance with legal obligations.

## Service providers

We use Fly.io for hosted infrastructure, Stripe for subscriptions and payments, and GitHub for software releases and connected GitHub features. Slack, Discord, Linear, and other services receive data only when you choose to connect or use them.

Some providers may process data outside the European Economic Area. Where required, we use appropriate contractual safeguards for those transfers.

We do not sell personal data, share it with advertisers, or use it to train AI models.

## Retention and deletion

We keep account and organization data while your account remains active. We retain operational, workflow, and audit records while needed to provide and protect the service. Billing records may be kept for legally required accounting and tax periods. Short-lived authorization codes and sessions expire automatically.

You can request account deletion by emailing us. Some records may remain where the law requires it or where they form part of another organization's legitimate audit history.

## Cookies

The marketing website does not use analytics or advertising cookies. Hub uses only the session and security cookies needed to sign you in and operate your account.

## Your rights

Depending on applicable law, you may request access, correction, deletion, restriction, objection, or portability of your personal data. Email [hello@moboudra.com](mailto:hello@moboudra.com). You may also complain to the [Spanish Data Protection Agency](https://www.aepd.es/).

## Security

We use access controls, encrypted transport, and limited service permissions. No online service can guarantee absolute security. Read Paseo's [security model](https://github.com/getpaseo/paseo/blob/main/SECURITY.md) or report a vulnerability privately to [hello@moboudra.com](mailto:hello@moboudra.com).

## Children

The official services are for professional developers and are not directed at children under 16.

## Changes

We will update this page and its date when our services or data practices materially change.
