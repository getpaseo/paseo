---
title: Resource limits
description: Give each agent its own Linux CPU priority, CPU share, CPU ceiling and memory limit, and change them while the agent runs.
nav: Resource limits
order: 43
category: Configuration
---

# Resource limits

On Linux, each agent can run under its own resource policy: a scheduling priority, a share of CPU time, a CPU ceiling, memory limits and a set of CPUs. The policy applies to the agent's provider process and everything it starts, such as builds, test runners and MCP servers. It never applies to the Paseo daemon or to other agents.

Agents without a policy run exactly as they do without this feature.

A limit is either enforced or refused. Paseo does not start an agent, save a policy or save a schedule with a control the host or the agent's provider cannot enforce; the error names each control and the reason.

## Controls

| Control     | Flag            | Range                | What it does                                                                                            |
| ----------- | --------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| Niceness    | `--nice`        | -20 to 19            | Scheduling priority of the agent's processes. Higher is lower priority.                                 |
| CPU weight  | `--cpu-weight`  | 1 to 10000           | The agent's share of CPU time when CPUs are contended. The default for everything else is 100.          |
| CPU quota   | `--cpu-quota`   | percent of one CPU   | A hard ceiling on CPU time. `100` is one full CPU, `250` is two and a half.                             |
| Memory high | `--memory-high` | MiB                  | A throttling threshold. Above it the kernel slows the agent and reclaims its memory. Nothing is killed. |
| Memory max  | `--memory-max`  | MiB                  | A hard limit on RAM. Past it the kernel swaps the agent out, then ends one of its processes.            |
| CPUs        | `--cpus`        | list such as `0-3,6` | The logical CPUs the agent may run on. The agent does not start if the host cannot confine it to them.  |

### Niceness, weight and quota

These three solve different problems:

- **Niceness** and **CPU weight** only matter when something else wants the CPU. An idle machine gives a niceness-19 agent all the CPU it asks for. Niceness is a per-process setting that the kernel weighs within the agent's group; CPU weight divides time between groups, so it is the control that keeps one agent from crowding out another agent or the daemon.
- **CPU quota** is a ceiling that applies even on an idle machine. Use it to keep an agent from heating a laptop or saturating a shared server.

### Memory high and memory max

`--memory-high` is pressure: the agent slows down as it approaches the threshold. `--memory-max` is enforced: the agent's processes never hold more RAM than that. On a host with swap the kernel pages the excess out first, so a runaway process gets slow before anything dies. Once RAM and swap are exhausted the kernel ends the largest process in the agent. The provider keeps running and sees that one command fail, unless the provider itself was the largest. On systemd older than 253 the kill stops the whole provider. Set `--memory-high` below `--memory-max` to get throttling before termination.

## Requirements

Every control needs a Linux host. Niceness needs the `nice` command (coreutils or BusyBox). CPU weight, CPU quota, memory and CPU sets also need:

- **systemd 244 or newer**, with a running manager the daemon can reach. A daemon running as your user uses your systemd user manager (`systemctl --user`). A daemon running as root uses the system manager.
- **cgroup v2** mounted at `/sys/fs/cgroup`. This is the default on Fedora 31+, Ubuntu 21.10+, Debian 11+, Arch and RHEL 9.
- The **`cpu`, `memory` and `cpuset` controllers delegated** to that manager. User managers get `cpu`, `memory` and `pids` by default on current distributions; `cpuset` usually has to be added.

Check what your user manager can control:

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
```

To delegate `cpuset` as well, create `/etc/systemd/system/user@.service.d/delegate.conf`:

```ini
[Service]
Delegate=cpu cpuset io memory pids
```

then run `sudo systemctl daemon-reload` and log out and back in.

Paseo never asks for root and never runs `sudo`.

### Without systemd or cgroup v2

- Linux without a usable systemd manager (most Docker containers) supports **niceness** only. A policy with any other control is refused.
- macOS and Windows support nothing. Every policy is refused, and the CLI says the host does not support resource controls.

`paseo agent inspect` reports a stored policy the host can no longer enforce, for example after `PASEO_HOME` moved to another machine, as `unsupported` with the reason. That agent does not start until you change the policy.

### Raising priority

An unprivileged daemon can lower an agent's priority (raise its niceness) but cannot raise it above its own. A niceness below the daemon's, such as `--nice -5`, needs `CAP_SYS_NICE` or an `RLIMIT_NICE` allowance for the daemon's user; without it the policy is refused. Moving a running agent back towards the daemon's priority, for example from `--nice 15` to `--nice 5`, needs the same privilege. Without it the policy is saved, the running processes keep their priority and the control is reported as `denied` until you reload the agent.

### Providers that share a process

OpenCode serves several agents from one server process, and plugin providers run inside the shared plugin worker. A per-agent limit cannot be enforced on a shared process, so a policy for one of their agents is refused.

## Set a policy

New agent:

```bash
paseo run --provider codex --nice 10 --cpu-quota 200 --memory-max 8192 "Run the full test suite and fix failures"
```

Schedule, applied independently to every run's new agent:

```bash
paseo schedule create \
  --name maintenance \
  --every 1h \
  --provider claude \
  --nice 15 \
  --cpu-quota 100 \
  --memory-max 2048 \
  "Update dependencies and open a PR if tests pass"
```

Heartbeat schedules wake an existing agent, so they keep that agent's policy.

Agents created by an agent, on this host or a connected one, get a copy of their creator's policy. Each copy is a separate limit, not a share of the creator's. Creating a child on a provider that cannot enforce it is refused. Paseo's MCP tools do not let an agent set or change a policy.

A policy limits the processes Paseo starts for an agent. It is not a sandbox: agents run as your user and can start processes outside their limits, for example with their own `systemd-run`, or change a policy through the Paseo CLI.

## Change a running agent

`paseo agent update` changes only the controls you pass. `none` removes one:

```bash
paseo agent update <agent-id> --nice 19 --cpu-quota 50
paseo agent update <agent-id> --memory-high none
```

Schedules take the same flags:

```bash
paseo schedule update <schedule-id> --memory-max 4096
```

CPU, memory and CPU-set changes take effect immediately, without restarting the agent. Niceness changes apply to every running thread of the agent.

An agent that was started without a policy has no resource boundary yet, so new CPU and memory limits show as `pending` until its next start. Reload the agent to apply them. Niceness applies immediately either way.

## Inspect

```bash
paseo agent inspect <agent-id>
```

The `Resources` row shows each configured control and its state:

| State         | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `applied`     | The running agent has this value.                        |
| `pending`     | Stored. It applies when the agent's runtime next starts. |
| `unsupported` | This host or provider can no longer enforce it.          |
| `denied`      | The host refused for lack of privilege.                  |
| `failed`      | Applying it failed for another reason.                   |

`paseo schedule inspect <schedule-id>` shows a schedule's stored policy.

## Verify with Linux tools

Each agent with a policy gets a systemd slice named `paseo_<hash>-agent_<hash>.slice`, under one slice per daemon. List them:

```bash
systemctl --user list-units 'paseo_*' --all
systemd-cgls --user-unit 'paseo_*'
```

Read the limits systemd set and the kernel enforces:

```bash
systemctl --user show <slice> -p CPUWeight,CPUQuotaPerSecUSec,MemoryHigh,MemoryMax,AllowedCPUs
cat /sys/fs/cgroup$(systemctl --user show <slice> -p ControlGroup --value)/cpu.max
cat /sys/fs/cgroup$(systemctl --user show <slice> -p ControlGroup --value)/memory.max
```

Find the slice of a process, and its niceness:

```bash
cat /proc/<pid>/cgroup
ps -o pid,ni,cmd --ppid <pid>
```

Watch usage live with `systemd-cgtop --user`.

## Troubleshooting

**Every cgroup control is refused.** Run `systemctl --user status`. If it fails, the daemon has no user manager: start the daemon from a login session, or enable lingering with `loginctl enable-linger $USER` for a daemon that starts at boot.

**`--cpus` is refused but the others work.** The `cpuset` controller is not delegated. See [Requirements](#requirements).

**An agent fails to start after you set a policy.** Paseo does not start an agent whose policy the host cannot enforce, whose resource slice systemd refused to create, or which the kernel could not confine to the requested CPUs. The error names the control and the reason. Clear the policy with `paseo agent update <agent-id> --cpu-quota none ...` or fix the host.

**A command or the provider is killed mid-turn.** The agent hit `--memory-max`. Check `journalctl --user -u <slice>` for the OOM event, then raise the limit or add `--memory-high` below it.

**Slices are left after a crash.** The daemon removes its leftover slices on its next start. To remove them by hand, stop the daemon's own slice. This kills every agent process of that daemon, so stop the daemon first:

```bash
systemctl --user stop "paseo_$(printf %s ~/.paseo | sha256sum | cut -c1-10).slice"
```

Replace `~/.paseo` with the daemon's `PASEO_HOME` if it uses another. Other Paseo homes on the machine have their own slices.
