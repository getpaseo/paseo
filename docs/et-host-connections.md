# Eternal Terminal host connection spec

Add **Eternal Terminal** to **Add host** for a running Paseo daemon on a remote machine. Use the same host profile, connection picker, and reconnect flow as Remote SSH. A daemon reached over both transports appears as one host with two saved connections.

## Scope

Support direct ET connections in the macOS and Linux desktop app, the CLI, and daemon-owned [connected hosts](connected-hosts.md). Install ET 7.1.1 or later on the machine that opens the connection and on the remote host. The remote host runs `etserver`, has working noninteractive SSH authentication, and runs Paseo on a loopback TCP port. If daemon A owns a registration for B, A runs `et`. Apps use the existing route through A.

Native Windows, standalone browser web, and mobile have no direct ET connection in v1. ET 7.1.1 rejects `-W` on native Windows. When evaluating Windows support, start with a separate proof of `-N -L` with a loopback bind, reliable readiness, and port cleanup. [ET 7.1.1 release](https://github.com/MisterTea/EternalTerminal/releases/tag/et-v7.1.1) · [ET Windows restriction](https://github.com/MisterTea/EternalTerminal/blob/et-v7.1.1/src/terminal/TerminalClient.cpp#L247-L258)

## Connection address

```text
et://deploy@build-box:2022?sshPort=2222&daemonPort=6767
```

| Part               | Meaning                                                                       | Default                                |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------- |
| `deploy@build-box` | Optional SSH user and required hostname, SSH alias, or bracketed IPv6 address | OpenSSH resolves the user when omitted |
| `:2022`            | ET server TCP port                                                            | `2022`                                 |
| `sshPort`          | SSH authentication port                                                       | OpenSSH configuration or its default   |
| `daemonPort`       | Paseo port on remote `127.0.0.1`                                              | `6767`                                 |

Use the same credential handling as Remote SSH. The desktop form has a separate **Paseo password** field. CLI and daemon-owned target parsing accept `password` in the query where URI credentials are supported. Keep that value separate from the launch target, preserve password whitespace, and omit credentials from descriptions and errors. The saved connection stores a distinct `remoteEt` kind, keyed by the normalized destination and port settings. An omitted SSH port delegates to SSH config and is distinct from an explicit `22`.

## Transport and recovery

ET's `-W` carries the daemon WebSocket byte stream over ET stdin and stdout. Reuse the one-connection loopback proxy and child lifecycle used by SSH. Electron main owns the desktop process and keeps using its existing IPC transport. The Node connector owns CLI and daemon-to-daemon attempts. The WebSocket upgrade, Paseo authentication, and `server_info` remain the connection readiness criteria. The destination daemon receives its usual protocol and needs no new RPC or feature bit. [ET stdio forwarding](https://github.com/MisterTea/EternalTerminal/pull/849)

During a network interruption, ET can resume the stream while its process and the Paseo WebSocket are still open. Paseo retains its existing startup and liveness deadlines initially. Once an attempt closes, its owner releases the proxy and process, then follows its existing retry policy. A new session goes through the ordinary identity and subscription recovery. Requests with unknown outcomes follow the [existing recovery contract](connected-hosts.md#connections-and-recovery).

## Implementation checklist

Write a failing behavioral test before each implementation slice, then make it pass. Check each item when its acceptance criteria are met. Record the evidence for the live checks in the implementation PR.

- [x] **Prove the ET byte stream.** Use real ET 7.1.1 binaries with a remote or isolated Paseo daemon. Open `/ws` through a child with piped stdio and exercise a text request and a binary terminal message. Confirm a short network interruption preserves the child and WebSocket. Capture what ET reports for failed SSH bootstrap, unreachable `etserver`, and a refused daemon connection. Use this result to settle the launch flags and diagnostic mapping before sharing the tunnel code.
- [x] **Add shared ET target parsing and arguments.** Extend [the host target parser](../packages/protocol/src/host-target.ts) and reuse SSH host and port validation where it fits. Accept SSH aliases and bracketed IPv6, normalize default ports, and reject invalid ports, duplicate or unknown query options, fragments, userinfo passwords, and nonempty paths other than `/`. Build an argument array for `et --no-persist --port <etPort> -W 127.0.0.1:<daemonPort>` with `-p <sshPort>` when supplied. Confirm batch mode, disabled inherited forwards, disabled agent forwarding and connection sharing, and normal SSH host key verification. Cover grammar, redaction, and exact argument construction in the protocol suites.
- [x] **Share the process tunnel.** Consolidate the process and single-use loopback proxy in [the Node SSH tunnel](../packages/client/src/node/ssh-tunnel.ts) and [the Electron transport manager](../packages/desktop/src/daemon/local-transport.ts). Keep executable and argument selection specific to each transport. Preserve Electron's launch environment cleanup, current setup deadlines, and SSH error handling. Close the listener, socket, and child on cancellation, failure, and shutdown, including cancellation during setup. Verify ET teardown releases the remote forward or leaves it with a bounded lifetime.
- [x] **Wire Node callers and failures.** Route `et://` through [the Node connector](../packages/client/src/node/index.ts), which already serves the CLI and [connected-host registry](../packages/server/src/server/connected-hosts/index.ts). Confirm CLI target selection and daemon-owned registration through those entry points. Report missing or unsupported local ET separately from setup failures. Use bounded, sanitized diagnostic details when available. ET may emit setup errors on stdout, so an invalid WebSocket upgrade still needs a useful failure when stderr is empty. Keep raw stream bytes out of diagnostic logs and leave Paseo password rejection to the existing auth path. [ET setup error handling](https://github.com/MisterTea/EternalTerminal/blob/et-v7.1.1/src/terminal/TerminalClientMain.cpp#L1620-L1640)
- [x] **Carry ET through the desktop host model.** Add `remoteEt` to [saved connections](../packages/app/src/types/host-connection.ts) and carry the target through the [desktop transport bridge](../packages/app/src/desktop/daemon/desktop-daemon-transport.ts). Validate inputs in Electron main and gate the feature by the executing platform. Share target mapping between [connection probing](../packages/app/src/utils/test-daemon-connection.ts) and [the host runtime](../packages/app/src/runtime/host-runtime.ts). Verify ET and SSH merge into one host by `serverId`, retain separate connection identities, and survive save/reload. Follow [saved host storage rules](data-model.md#saved-hosts).
- [x] **Reuse the Add host design.** Add an **Eternal Terminal** row to [the existing method picker](../packages/app/src/hosts/add-host/internal/add-host-method-modal.tsx) on supported Electron platforms. Use [the shared remote host sheet](../packages/app/src/hosts/add-host/internal/add-remote-host-modal.tsx) for the target and password fields, pending and error states, and probe/save flow. Parameterize the differences and use existing form primitives and localized strings. Show **Eternal Terminal** through [the existing connection display](../packages/app/src/hosts/connection-display.ts). Follow [design](design.md) and [forms](forms.md).
- [ ] **Verify recovery and regressions.** Run the affected existing suites. On macOS and Linux, exercise the desktop form, CLI, and daemon-owned registration against real ET with custom ports and Paseo auth. Record whether a brief outage and sleep/wake preserve the same child and WebSocket. Confirm a longer outage or an `etserver` restart opens a new session and restores subscriptions. If Paseo closes recoverable streams before ET can resume them, measure the timing and set a bounded ET grace period before release. Verify ET entries survive an app downgrade and re-upgrade. Confirm SSH, local socket, and pipe regressions are covered, and ET is unavailable on unsupported platforms. Collect [QA evidence](qa.md#evidence).
- [x] **Document usage.** Add a CLI example to the [CLI reference](../public-docs/cli.md#eternal-terminal) and document prerequisites and troubleshooting in the relevant host connection guidance. Run `npm run typecheck` and `npm run lint` before handing off the implementation.

## Linux verification

An isolated ET 7.1.1 tunnel carried a Paseo ping and binary terminal output. A one-second cut to the ET TCP connection resumed on the same ET process and Paseo WebSocket. The live CLI and daemon-owned registration also connected with three custom ports and a Paseo password. An existing routed workspace client recovered after an `etserver` restart.

An unreachable `etserver` produced a stdout error and empty stderr. A refused daemon port closed the stream with exit status zero and no output. In both cases the failed WebSocket handshake is the signal that setup failed.
