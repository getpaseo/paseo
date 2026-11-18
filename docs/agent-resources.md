# Agent resources

How per-agent Linux resource policies are enforced. User-facing behavior, controls and requirements are in [public-docs/resource-limits.md](../public-docs/resource-limits.md).

## Enforced or refused

A policy is a promise about every control in it. `AgentResources.assertEnforceable` rejects a policy with a control the host or the agent's provider cannot enforce, with `UnenforceableAgentResourcePolicyError` naming each control. It runs before a policy is stored (`setAgentResources`, schedule create and update), before an agent is created, and again inside every `open`, so resume, reload and import are covered without their own checks. An `AgentManager` built without `resources` refuses every policy.

Two things are not refusals, because the policy is enforceable and only the running processes lag behind it. Both are reported in the status and end when the agent next starts:

- cgroup controls set on an agent that started without a policy are `pending`. Its processes already sit in the daemon's cgroup and a slice cannot be retrofitted.
- a niceness the kernel will not give to running threads (moving from 15 back to 5 needs privilege) is `denied`.

`unsupported` in a status means a stored policy outlived the host or provider that accepted it. That agent fails to open until the policy changes.

`server_info.features.agentResources` is true only on Linux, where at least niceness can be enforced.

## Shape

`AgentResources` (`packages/server/src/server/agent/resources/`) owns the host side. The agent manager asks it for a lease before every provider open (create, resume, import, reload) and releases the lease after the session closes. The lease carries an `AgentResourceLaunch` that the agent manager puts on `AgentLaunchContext.resources`.

Each agent with a policy gets a transient systemd slice created over D-Bus (`StartTransientUnit`, through `busctl`), and the open waits until systemd reports the slice `active` (a start queued behind another job reads `inactive` first). Every provider process starts in its own scope inside that slice. Limits live on the slice, so a reload or a second process of the same agent shares them, and two agents never share a slice. All agent slices sit under `paseo_<hash of PASEO_HOME>.slice`; the daemon stops that root slice on startup and shutdown, which reaps anything a crashed daemon left. Unit names are built from hashes only. No caller text reaches systemd.

`startSlice` stops the unit name before it starts it. systemd accepts `StartTransientUnit` for a slice that already exists, returns success, and leaves the processes in it where they are, so without the stop a new runtime would join whatever an untracked leftover held.

Every `busctl`, `systemctl` and `systemd-run` call carries `XDG_RUNTIME_DIR` (`/run/user/<uid>` when the daemon's environment lacks it). A daemon started outside a login session, for example by a lingering user service, has neither that nor `DBUS_SESSION_BUS_ADDRESS`, and the systemd tools cannot find the user manager without one of them.

## Starting processes in the slice

`spawnProcess(..., { resources })` rewrites the launch to `systemd-run --scope --slice=<slice> -- [nice -n <adj>] <command>`. `systemd-run --scope` registers its own PID as the scope and then `exec`s the command, and so does `nice`, so the PID, stdio pipes, signals and exit status the provider sees belong to the provider binary, and everything the provider forks starts inside the slice. Wrapping with `systemd-run` as a _service_ would break all of this: stdio would go through the journal and the child would not be ours.

Each of these on that command line was a bug before it was there:

- `--expand-environment=no` (systemd 254+). Without it `systemd-run` rewrites `$VAR` and `$$` inside the provider's arguments, which corrupts inline JSON and shell snippets providers pass.
- `XDG_RUNTIME_DIR` in the child env, for the reason above. When the provider's own environment has a different value, `--setenv` gives it back to the provider.
- `TimeoutStopSec=3s` on the scope, so stopping the slice SIGKILLs survivors quickly instead of waiting 90 seconds.
- `OOMPolicy=continue` on the scope (systemd 253+). The default, `stop`, makes systemd stop the whole scope as soon as the kernel kills one process in it for memory, which turns one killed build into a dead provider.

A provider that adopts resource controls passes `launchContext.resources` to every `spawnProcess` call that belongs to the agent, including tool and terminal subprocesses it starts as siblings. A provider whose process serves more than one agent sets `AgentClient.sharesProcessAcrossAgents`; a policy for one of its agents is refused. The registry wrapper in `provider-registry.ts` copies client fields one by one, so a new client field has to be forwarded there.

Terminals opened through Paseo's terminal tools run in the terminal worker, outside the agent's slice.

## Niceness

Niceness belongs to a thread, not a cgroup, and a new thread or process copies its creator's. Setting it after `spawn` returns is too late: the child may already have forked or started threads, which keep the old value. So the launch goes through `nice -n <adjustment>`, which sets it before `exec`. The adjustment is relative to the niceness `nice` starts with, which is the daemon's.

Any `nice` works, with two differences that shaped the code. BusyBox `nice` runs a `--` before the command as the command, so none is passed. GNU `nice` starts the command anyway when the kernel refuses the adjustment, while BusyBox exits; the launch therefore cannot be what detects a missing privilege.

Raising priority above the daemon's needs `CAP_SYS_NICE` or `RLIMIT_NICE`. `assertEnforceable` finds out by trying: `nice -n <adjustment> nice` prints the niceness it ended up with. Reading `CapEff` instead is wrong in a user namespace, where the capability is listed and the kernel still refuses.

A live change walks every thread in the slice (`cgroup.threads`, recursively) and renices it, then walks again for threads created from a stale value, up to three passes. Without a slice it walks `/proc` from the provider PIDs. Niceness is reported `applied` only when every thread has it. A niceness set at launch is recorded like one set later, so clearing the policy restores the daemon's value or reports why it could not.

`os.setPriority` throws `ERR_SYSTEM_ERROR` with the errno under `info.code`; read it with `errnoOf`.

## Memory

`memoryMaxMb` is systemd's `MemoryMax`, which caps RAM and leaves swap alone. On a host with swap, a process over the limit is paged out and keeps running; the OOM killer only acts when swap is exhausted too. Paseo does not set `MemorySwapMax`.

## Live updates and races

`SetUnitProperties` with `runtime=true` changes a slice without writing anything that outlives it. A control dropped from the policy is written as systemd's "unset" (`UINT64_MAX`, or an empty `AllowedCPUs`), so removing a limit lifts it. A removal the host refuses stays in the status as `denied` or `failed`, and is part of every later update, until one succeeds: the old limit is still in force.

`setAgentResources` runs in the agent's lifecycle lane, so it never overlaps an open, reload or close. Loaders build resume overrides before entering the lane, so resume takes the policy from the record it reads inside the lane, not from the overrides.

A slice that cannot be stopped when its last lease is released stays registered; the next open of that agent stops it first and fails if it still cannot. Stopping a slice ends every process in it, including ones the provider detached.

## Status

`status()` reads values back from the kernel (`cpu.max`, `cpu.weight`, `memory.high`, `memory.max`, `cpuset.cpus.effective`, per-thread niceness) instead of echoing the request. The CPU set is the effective one, and `allowedCpus` is a ceiling: the kernel narrows it to the requested CPUs the parent has, which still confines the agent, and an open accepts that. When none of the requested CPUs is available, the kernel runs the slice on the parent's CPUs without an error; the policy is refused up front against the manager's own `cpuset.cpus.effective`, and the open checks the slice again after creating it. Stored policy and in-force status travel separately: the snapshot carries `resources` (stored), and `agent.resources.get.request` returns `status`.

## What a policy does not guarantee

A policy limits the processes Paseo starts for an agent. It is not a sandbox. Agents run as the daemon's user, so an agent can start processes outside its slice, for example with its own `systemd-run`, or drive the daemon through the local CLI. A child agent gets a copy of its creator's policy, on this host or a connected one; it is a separate limit, not a share of the creator's, and creating a child on a provider that cannot enforce it is refused. Only agent-scoped MCP calls are refused when they try to set a policy.

## Testing

`systemd.local.e2e.test.ts` runs against the real user manager, real cgroups and real processes: cgroup membership, kernel limit files, PIDs, stdio, signals, live updates, cleanup, a leftover slice, an out-of-memory kill, and niceness for a provider that forks immediately. It needs a Linux host whose user manager delegates `cpu` and `memory`, so it is a local test and CI does not run it:

```bash
cd packages/server && npx vitest run src/server/agent/resources/systemd.local.e2e.test.ts
```

Everything that needs a host the test machine is not (permission failures, undelegated controllers, failed stops, unavailable CPUs, BusyBox, macOS) is covered with the fake host in `fake-host.ts`, which fails the way Node, systemd and the kernel do.
