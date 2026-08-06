---
title: Hub quickstart
description: Sign in, connect GitHub, register a daemon, and get an agent starting from a mention.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

From an empty Hub to an agent that starts when someone mentions it. Each step links to the page that covers it properly.

## 1. Sign in

Open your Hub and sign in with the owner account created during deployment. Replace its temporary password when prompted. Your connections, daemons, and projects all live inside its organization.

## 2. Connect GitHub

Open **Connections** and connect GitHub. Choose the account or organization whose repositories you want to use.

The connection appears with a generated slug like `yourname-github`.

## 3. Register a daemon

On the machine that will run agents:

```sh
paseo hub connect https://your-hub.example.com
```

The CLI prints a verification code. In Hub, open **Daemons → Register a daemon**, enter the code, and choose a friendly slug. Hub normalizes `Build Studio` to `build-studio`. See [Daemons](/docs/hub/daemons).

## 4. Create a project

Open **Projects → New project**. On its **Configuration** tab, pick a repository and choose **Use for configuration**. Hub now reads `.paseo/hub.yml` from that repository's default branch.

## 5. Commit the configuration

Add `.paseo/hub.yml` to that repository:

```yaml
project: your-project

environments:
  - name: dev
    kind: daemon
    daemon: my-daemon
    cwd: /Users/you/code/your-repo

triggers:
  - name: mention
    on: github.issue_comment
    max_runtime: 2h
    filters:
      repo: yourname/your-repo
      contains: "@paseo"
      from_users: [your-github-login]
    steps:
      - id: work
        environment: dev
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Someone asked for help.
              ${{ paseo.prompt }}
```

`project` is the project slug from step 4. The deploy CLI reads it as deployment metadata; it does not affect workflow behavior. `daemon` is the normalized slug from step 3. `cwd` is a directory on that machine.

## 6. Push

Push to the default branch. Hub fetches the file at that commit, validates it, and activates it. The **Configuration** tab shows the active revision and the last sync.

If the file is invalid, Hub records the failure and keeps the previous revision active.

To deploy the file directly instead, create an organization API key with the `configuration:install` scope, then run:

```sh
export PASEO_HUB_URL=https://your-hub.example.com
export PASEO_HUB_API_KEY=paseo_pk_...
paseo hub deploy
```

The command reads exactly `.paseo/hub.yml` from the current directory. It does not search parent directories. Use `paseo hub deploy path/to/config.yml` for another file. `-p, --project <slug>` overrides the file's `project` metadata. See [Hub configuration](/docs/hub/configuration#deploy-from-the-cli) for every deploy option and the current authentication limits.

## 7. Trigger it

Comment `@paseo have a look at this` on an issue in that repository, from the account you listed in `from_users`.

Open the project's **Activity** tab. You should see the event received and routed, and an execution in **Executions**. The agent itself appears in the Paseo app on that machine.

Nothing happened? [Activity](/docs/hub/activity) has the checklist.
