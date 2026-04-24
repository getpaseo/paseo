<p align="center">
  <a href="https://hubcode.ai"><img src="https://hubcode.ai/logo-hubcode.png" alt="Hubcode" width="120"/></a>
</p>

<h1 align="center">@hubcode/relay</h1>

<p align="center">
  End-to-end encrypted relay for secure remote access to Hubcode daemons.
</p>

## What it is

The relay lets a Hubcode mobile/desktop client connect to a daemon running behind NAT or on a different network, without either side accepting inbound connections from the internet.

- **End-to-end encrypted**: the relay only forwards ciphertext; it cannot read messages
- **Zero-trust**: daemon and client authenticate via a pairing key exchange, not relay credentials
- **Cloudflare Workers adapter** included for self-hosting

See the [Hubcode security model](https://github.com/hubtool/hubcode/blob/main/SECURITY.md) for details.

## Install

```bash
npm install @hubcode/relay
```

## Exports

- `@hubcode/relay` — core relay transport
- `@hubcode/relay/e2ee` — end-to-end encryption helpers
- `@hubcode/relay/cloudflare` — Cloudflare Workers adapter

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
