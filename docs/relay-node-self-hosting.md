# Node Relay Self-Hosting

This document describes the experimental Node.js relay runtime for `@getpaseo/relay/node`.

## Status

This runtime is experimental.

- single-process only
- in-memory session state only
- no multi-instance support
- no durable crash recovery

## Start

```bash
npm run build --workspace=@getpaseo/relay
HOST=0.0.0.0 PORT=8787 npm run start:node --workspace=@getpaseo/relay
```

## Health Check

```bash
curl http://127.0.0.1:8787/health
```

## Daemon Configuration

If you start the daemon from a shell, set:

```bash
export PASEO_RELAY_ENDPOINT=your-host.example.com:8787
export PASEO_RELAY_PUBLIC_ENDPOINT=your-host.example.com:8787
```

Start the daemon from that same shell.

If you use a desktop-managed daemon, write the endpoints to `~/.paseo/config.json` instead:

```json
{
  "endpoint": "your-host.example.com:8787",
  "publicEndpoint": "your-host.example.com:8787"
}
```

Restart the daemon after updating the config.

## Notes

- The relay protocol remains the same as the existing Cloudflare runtime.
- Existing pairing and custom relay endpoint behavior do not need schema changes.
- If you need TLS, place the relay behind a reverse proxy or terminate TLS outside this first implementation.
