# Paseo Docker images

Run the Paseo daemon headless in a container. Mount your code, pick your agents,
connect the Paseo app/CLI from anywhere.

- **`base/`** — the daemon image. One Dockerfile, several distro flavors
  (Ubuntu 24.04/22.04, Debian 12/13, Alpine). Built on a vendored
  [s6-overlay](https://github.com/just-containers/s6-overlay) + a small Docker
  Mods loader.
- **`mods/`** — agent Docker Mods. Tiny `FROM scratch` images that install one
  agent CLI each at container startup. Compose them with `DOCKER_MODS`.
- **`docker-compose.example.yml`** — a ready-to-edit deployment.

## Quick start

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -e DOCKER_MODS=ghcr.io/getpaseo/mods:claude-code \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:debian
```

Then point the Paseo app/CLI at `http://<host>:6767`.

The default persistent home is `/home/paseo`. To use another path, set
`PASEO_HOME` and mount that same path, for example
`-e PASEO_HOME=/var/lib/paseo -v paseo-state:/var/lib/paseo`.

On startup the container prints a pairing QR code and link to its logs once the
daemon is listening — run `docker logs paseo` and scan it with the Paseo app.
Set `-e PASEO_PAIRING_QR=0` to disable.

## Images

| Image                                   | Notes                                    |
| --------------------------------------- | ---------------------------------------- |
| `ghcr.io/getpaseo/paseo:debian`         | Default. Debian, glibc.                  |
| `ghcr.io/getpaseo/paseo:ubuntu`         | Ubuntu, glibc.                           |
| `ghcr.io/getpaseo/paseo:alpine`         | Smallest. musl — some agents N/A.        |
| `ghcr.io/getpaseo/paseo:<ver>-<distro>` | Version-pinned (e.g. `0.1.89-debian13`). |

## Agent mods

| Mod                                 | Installs                    | Provider   |
| ----------------------------------- | --------------------------- | ---------- |
| `ghcr.io/getpaseo/mods:claude-code` | `@anthropic-ai/claude-code` | `claude`   |
| `ghcr.io/getpaseo/mods:codex`       | `@openai/codex`             | `codex`    |
| `ghcr.io/getpaseo/mods:copilot`     | `@github/copilot`           | `copilot`  |
| `ghcr.io/getpaseo/mods:opencode`    | `opencode-ai`               | `opencode` |
| `ghcr.io/getpaseo/mods:pi`          | `@mariozechner/pi`          | `pi`       |

Combine them: `DOCKER_MODS=ghcr.io/getpaseo/mods:claude-code|ghcr.io/getpaseo/mods:codex`.

Use the same Paseo daemon/provider env vars you would pass outside Docker; see
[../docs/docker.md](../docs/docker.md) for volumes, env vars, agent auth,
security, and how to build the images locally.

Set `PASEO_ENABLE_SUDO=true` only when trusted agents need passwordless `sudo`
inside the container, for example to install OS packages for project tests. See
[../docs/docker.md](../docs/docker.md) for the security tradeoff.
