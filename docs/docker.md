# Running Paseo in Docker

Paseo ships official container images that run the **daemon** headless. You mount
your code and persistent state as volumes, pick which agents to install with
**Docker Mods**, and connect the Paseo app/CLI to the exposed port.

The image sources live in [`docker/`](../docker/).

## How it works

- **Base image** (`docker/base`) — one Dockerfile parametrized by `BASE_IMAGE`,
  built for Ubuntu 24.04/22.04, Debian 12/13 and Alpine. It bundles Node 22, the
  Paseo server + CLI installed from npm (`@getpaseo/server`, `@getpaseo/cli`), a
  vendored [s6-overlay](https://github.com/just-containers/s6-overlay) as PID 1,
  and a small Docker Mods loader.
- **Boot sequence** (s6 services, in order):
  1. `init-paseo` — re-maps the `paseo` user to `PUID`/`PGID` and prepares `/config`.
  2. `init-docker-mods` — runs the loader: for each image in `DOCKER_MODS` it
     pulls the layers straight from the registry, extracts them, and runs the
     mod's install hook (`/etc/paseo-mods/<name>/install`).
  3. `svc-paseo` — launches the daemon as the unprivileged `paseo` user. It
     depends on the mods step, so any agents you requested are on `PATH` before
     the daemon probes provider availability.
- **Agent mods** (`docker/mods/*`) — tiny `FROM scratch` images whose only job is
  to drop an install hook that runs `npm install -g <agent-cli>`. Paseo discovers
  the agent by finding its binary on `PATH`.

## Images

| Image                                   | Base             | libc            |
| --------------------------------------- | ---------------- | --------------- |
| `ghcr.io/getpaseo/paseo:debian`         | `debian:13-slim` | glibc (default) |
| `ghcr.io/getpaseo/paseo:ubuntu`         | `ubuntu:24.04`   | glibc           |
| `ghcr.io/getpaseo/paseo:alpine`         | `alpine:3.21`    | musl            |
| `ghcr.io/getpaseo/paseo:arch`           | `archlinux:base` | glibc           |
| `ghcr.io/getpaseo/paseo:<ver>-<distro>` | pinned           | —               |

`<distro>` tags: `debian12`, `debian13`, `ubuntu2204`, `ubuntu2404`, `alpine`,
`arch`. The moving `:debian` / `:ubuntu` / `:alpine` / `:arch` tags track the
newest version. `:latest` aliases `:debian`. All images are multi-arch
(`amd64`, `arm64`) **except `:arch`, which is `amd64`-only** (the official Arch
base has no arm64 build — on Apple Silicon / arm64 hosts use Debian, Ubuntu, or
Alpine).

## Quick start

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -e DOCKER_MODS=ghcr.io/getpaseo/mods:claude-code \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v "$PWD/paseo-config:/config" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:debian
```

If agents need to install OS packages inside the container, opt in to
passwordless sudo for the `paseo` user:

```bash
docker run -e PASEO_ENABLE_SUDO=true ...
```

Connect the app/CLI to `http://<host>:6767` using `PASEO_PASSWORD`:

```bash
PASEO_HOST=<host>:6767 PASEO_PASSWORD=change-me paseo daemon status
```

A `docker compose` deployment is in
[`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml).

## Volumes

| Mount        | Purpose                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/config`    | `PASEO_HOME` — `config.json`, `agents/`, `projects/`, `loops/`, logs, **and** agent credentials (`~/.claude`, `~/.codex`, ...). `HOME` is set to `/config`, so everything an agent writes to its home dir persists here. |
| `/workspace` | The code Paseo operates on. Bind-mount one or more of your repos.                                                                                                                                                        |

Set `PUID`/`PGID` to the uid/gid that owns the bind-mounted folders on the host
(`id -u` / `id -g`) so the daemon and agents can read and write your files.

## Choosing agents (Docker Mods)

`DOCKER_MODS` is a pipe-separated list of mod images applied at startup:

```
DOCKER_MODS=ghcr.io/getpaseo/mods:claude-code|ghcr.io/getpaseo/mods:opencode
```

| Mod           | Package                     | Binary     | Alpine?                     |
| ------------- | --------------------------- | ---------- | --------------------------- |
| `claude-code` | `@anthropic-ai/claude-code` | `claude`   | yes (pure JS)               |
| `opencode`    | `opencode-ai`               | `opencode` | yes (pure JS)               |
| `copilot`     | `@github/copilot`           | `copilot`  | usually                     |
| `codex`       | `@openai/codex`             | `codex`    | **no** (native, glibc only) |
| `pi`          | `@mariozechner/pi`          | `pi`       | check                       |

Agents that ship a native binary via npm (notably Codex) have no musl build, so
use a glibc image (Debian/Ubuntu) for those. The `pi` package name is overridable
with `-e PI_NPM_PACKAGE=...` if it ever changes upstream.

Mod installs run on every fresh `docker run`; the hook skips reinstalling if the
binary is already present (e.g. after `docker restart`).

### Agent credentials

Each agent manages its own auth and stores it under `HOME` (`/config`), so it
persists across restarts. Provide credentials via env vars or by logging in once:

- **Claude** — `ANTHROPIC_API_KEY`, or run `claude` once to OAuth; config in `/config/.claude`.
- **Codex** — `OPENAI_API_KEY`; config in `/config/.codex`.
- **Copilot** — GitHub auth handled by the CLI.
- **OpenCode** — provider env vars (`OPENAI_API_KEY`, etc.).
- **Pi** — `/config/.pi/agent/auth.json`.

You can also configure custom providers / API endpoints in
`/config/config.json` under `agents.providers` — see
[custom-providers.md](custom-providers.md).

## Environment variables

Docker deployments use normal Paseo daemon/provider environment variables plus
a small set of container-only variables.

### Paseo daemon env vars

The Docker image does not define a separate Paseo daemon/provider environment
contract. Values passed with `docker run -e ...` or `compose.environment` are
inherited by the daemon and by agent/provider processes the same way they are
when you run Paseo directly on the host. This includes provider credentials and
endpoint variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_BASE_URL`, and `OPENAI_BASE_URL`.

Set `PASEO_PASSWORD` for any daemon reachable beyond localhost.

The image only changes a few container defaults:

- `PASEO_HOME=/config`, matching the persistent volume described above.
- `PASEO_LISTEN=0.0.0.0:6767`, so the daemon is reachable through Docker port
  publishing.
- `PASEO_LOG_FORMAT=json` in production.

For daemon/runtime env details, use the existing references:

- [development.md](development.md) for `PASEO_HOME`, daemon logs/log rotation,
  CLI host/password env, and workspace service script env.
- [service-proxy.md](service-proxy.md) for `PASEO_SERVICE_PROXY_*`.
- [custom-providers.md](custom-providers.md) for provider credentials, custom
  endpoints, and `agents.providers.*.env`.
- [SECURITY.md](../SECURITY.md) for exposed daemons, `PASEO_PASSWORD`, relay,
  and TLS guidance.

Generated workspace/service env vars such as `PASEO_SERVICE_<NAME>_URL`,
`PASEO_SERVICE_<NAME>_PORT`, `PASEO_PORT`, and `PASEO_WORKTREE_*` are injected
into scripts/agents by Paseo at runtime; you do not set them on the container.
See [development.md](development.md) for the generated service script env
contract.

### Container-only env vars

| Var                 | Default   | Purpose                                                            |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `DOCKER_MODS`       | (unset)   | Pipe-separated agent mod images to install.                        |
| `PUID` / `PGID`     | `911`     | uid/gid for the `paseo` user (match your volumes).                 |
| `PASEO_ENABLE_SUDO` | `false`   | Set to `true` to grant passwordless sudo to `paseo`.               |
| `PASEO_PAIRING_QR`  | (enabled) | Set to `0`/`false` to suppress the startup pairing QR in the logs. |

On startup the container prints a pairing QR code and link to its logs once the
daemon is listening (s6 `svc-paseo-pair` oneshot, best-effort — never blocks
boot). Scan it from `docker logs` with the Paseo app.

## Security

- The daemon binds `0.0.0.0` **inside** the container; you control exposure via
  the host port mapping. For anything reachable beyond localhost, **set
  `PASEO_PASSWORD`** and prefer the Paseo relay or a TLS reverse proxy. See
  [SECURITY.md](../SECURITY.md).
- Agents execute arbitrary code on your mounted workspace. The container is the
  isolation boundary; the daemon and agents run as the non-root `paseo` user.
- `PASEO_ENABLE_SUDO=true` lets the daemon and agents become root inside the
  container with `sudo` and install or modify OS packages. Use it only for
  trusted agents and trusted workspaces.
- The Docker Mods loader pulls **public** images anonymously over HTTPS. Only
  list mod images you trust — their layers are extracted into the container.

## Building locally

```bash
# Base image for one distro:
docker build --build-arg BASE_IMAGE=debian:13-slim -t paseo:debian docker/base
docker build --build-arg BASE_IMAGE=alpine:3.21    -t paseo:alpine docker/base
docker build --build-arg BASE_IMAGE=archlinux:base -t paseo:arch   docker/base

# Pin a Paseo version (defaults to the latest published):
docker build --build-arg BASE_IMAGE=ubuntu:24.04 --build-arg PASEO_VERSION=0.1.89 \
  -t paseo:ubuntu docker/base

# An agent mod:
docker build -t paseo-mod-claude docker/mods/claude-code
```

Multi-arch builds and registry publishing are wired up in
[`.github/workflows/docker.yml`](../.github/workflows/docker.yml), triggered on
release tags.

## Troubleshooting

- **Provider not showing up** — check the boot log (`docker logs paseo`) for
  `[mods]`/`[mod:<agent>]` lines. A failed `npm install` is logged but does not
  stop the daemon. On Alpine, native agents (Codex) will not install.
- **Can't connect / 403** — set `PASEO_HOSTNAMES` if reaching the daemon by a DNS
  name; IPs and `localhost` are allowed by default.
- **Permission errors on your repo** — set `PUID`/`PGID` to match the host owner
  of the bind mount.
- **Daemon logs** — `docker exec paseo tail -f /config/daemon.log`.
