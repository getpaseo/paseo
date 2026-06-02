# Service Proxy

Paseo can proxy HTTP traffic to services running inside your workspaces and expose them at stable, publicly-accessible URLs. This lets you open a running dev server from your phone or share it with a teammate without any tunneling tools.

## How it works

When a `paseo.json` script of `"type": "service"` starts, Paseo assigns it a local port and registers a route in the service proxy. Incoming requests whose `Host` header matches the script's generated hostname are forwarded to that port.

The generated hostname is built from the script name, branch, and project:

```
<script>--<branch>--<project>.<base-domain>
```

If the branch is `main` or `master`, the branch segment is omitted:

```
<script>--<project>.<base-domain>
```

**Example:** a script named `dev` in the `miniweb` project on branch `feature/auth` would be reachable at:

```
dev--feature-auth--miniweb.paseoapps.my.domain.com
```

The public route uses one combined leftmost label (`script--branch--project`) rather than the local development shape (`script.branch.project.localhost`). This is intentional: dotted script/branch/project hostnames would require multi-level wildcard DNS and certificates for arbitrary branch names, while a single label works with normal `*.base-domain` DNS and wildcard TLS. If the combined label would exceed DNS's 63-character label limit, Paseo truncates it.

## Configuration

Add a `serviceProxy` block under `daemon` in `~/.paseo/config.json`:

```json
{
  "version": 1,
  "daemon": {
    "serviceProxy": {
      "enabled": true,
      "listen": "0.0.0.0:8080",
      "publicBaseUrl": "https://paseoapps.my.domain.com"
    }
  }
}
```

| Field           | Required | Description                                                                                     |
| --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `enabled`       | No       | Enables the proxy. Defaults to `true` if `publicBaseUrl` is set, `false` otherwise.             |
| `listen`        | No       | Address and port the proxy listens on. Defaults to `127.0.0.1:6868`.                            |
| `publicBaseUrl` | No       | Base URL used to generate public service links. If omitted, links use localhost addresses only. |

## DNS and reverse proxy setup

For generated URLs to be reachable, you need wildcard DNS pointing to the machine running the Paseo daemon.

**Example:** to expose services at `https://dev--miniweb.paseoapps.my.domain.com` where the daemon host is `10.1.1.1`:

1. Configure a wildcard DNS record:

   ```
   *.paseoapps.my.domain.com  →  10.1.1.1
   ```

2. Set `publicBaseUrl` to `https://paseoapps.my.domain.com` in your config.

3. If you put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of the daemon, ensure it forwards the `Host` header unchanged. The proxy uses the `Host` header to route requests to the correct service — rewriting it will break routing.

   Nginx example:

   ```nginx
   server {
       listen 443 ssl;
       server_name *.paseoapps.my.domain.com;

       location / {
           proxy_pass http://10.1.1.1:8080;
           proxy_set_header Host $host;
       }
   }
   ```

## Environment variables

The listen address and public base URL can also be set via environment variables, which take precedence over `config.json`:

| Variable                              | Description                         |
| ------------------------------------- | ----------------------------------- |
| `PASEO_SERVICE_PROXY_ENABLED`         | `true` or `false`                   |
| `PASEO_SERVICE_PROXY_LISTEN`          | Listen address, e.g. `0.0.0.0:8080` |
| `PASEO_SERVICE_PROXY_PUBLIC_BASE_URL` | Public base URL                     |
