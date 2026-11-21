# Browser USB access and serial forwarding

Status: full USB/IP feasibility investigation and experimental serial-forwarding
plugin, checked 2026-10-19. Full USB/IP is unsupported.

The target is to use a USB device connected to the browser user's computer from
an application on a remote Paseo host, using that host's normal USB driver.
A serial byte stream is a narrower supported experiment: it lets agent tools
communicate with USB serial devices without a helper on the browser computer.
It does not create an imported USB device on the remote host.

The local computer must require only an ordinary browser page: no native helper,
USB/IP exporter, extension, Electron wrapper, or separately installed privileged
app. The remote host would still need a USB/IP importer and its normal device
drivers to make a forwarded device available to native applications.

**An ordinary Chrome/Brave page cannot export arbitrary USB devices under these
constraints.** Protected USB interfaces are inaccessible to the page. A plugin,
core settings page, or additional transport cannot grant that access. The result
is a feasibility limit. The serial plugin below provides a bounded alternative
for serial consoles and byte-oriented tools.

## Browser limits

| Approach                                                               | What it provides                                     | Why it cannot cover arbitrary USB/IP                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WebUSB](https://wicg.github.io/webusb/)                               | Transfers to browser-approved USB interfaces         | Ordinary pages cannot claim protected classes including HID, mass storage, audio, and video. A chooser grant does not lift those restrictions. A USB/IP exporter would also have to translate descriptors, control requests, transfer completion, cancellation, and errors. |
| [Web Serial](https://wicg.github.io/serial/)                           | Bytes and serial control signals for supported ports | It does not expose a complete USB device, its other interfaces, or USB request blocks.                                                                                                                                                                                      |
| [WebHID](https://wicg.github.io/webhid/)                               | Reports for permitted HID collections                | Protected usages remain blocked; reports do not provide general USB access.                                                                                                                                                                                                 |
| [Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets) | TCP/UDP in installed Isolated Web Apps               | This is not an API available to an ordinary Paseo web page, and sockets do not remove hardware API restrictions.                                                                                                                                                            |

[Chrome's WebUSB guide](https://developer.chrome.com/docs/capabilities/usb)
requires a secure context and user activation for device selection. Selection
grants access to the web origin, not to a remote operating system. A WebSocket
can carry bytes, but a native USB/IP peer expects its own TCP protocol. A
WebSocket-to-TCP adapter solves only that transport mismatch.

Do not infer support from a Chromium browser name. Check the actual APIs and
policies. For example, [Brave disables Web Serial by default](https://github.com/brave/brave-browser/wiki/Deviations-from-Chromium-%28features-we-disable-or-remove%29).
Browser extensions, Electron permissions, and native messaging require separate
installation and authority; none is a portable browser-only solution.

The WebUSB specification defines an exception:
[`usb-unrestricted`](https://github.com/WICG/webusb/blob/main/unrestricted-usb-explainer.md)
allows installed Isolated Web Apps to access blocklisted devices and protected
classes. Together with Direct Sockets, this is a candidate for a separately
packaged USB redirection app. It still needs a USB/IP translation implementation,
OS-specific device access, a native importer, and compatibility testing. An
ordinary web page cannot enable it with a Permissions Policy header, and a
normal PWA install does not turn Paseo into an IWA. No Chrome/Brave cross-platform
IWA deployment or USB/IP implementation was validated here. An installed IWA is
outside this investigation's ordinary-browser requirement; it is not evidence
that the existing web app supports unrestricted access.

## Existing implementations and excluded alternatives

USB/IP calls the machine with the physical device the **server/exporter** and
the machine running the device driver the **client/importer**. For this workflow,
the remote Paseo host is the USB/IP client. Keep those roles explicit in code and
UI; they are the reverse of the Paseo browser/daemon naming.

The [Linux protocol documentation](https://docs.kernel.org/usb/usbip_protocol.html)
defines device listing and import over TCP, followed by USB request submission,
completion, and unlink messages on the imported device's connection. The
receiving machine needs a virtual host controller and the relevant device driver.

| Candidate                                                                                                                                                    | Role                                                                       | Assessment                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Linux USB/IP](https://github.com/torvalds/linux/tree/master/tools/usb/usbip)                                                                                | Native exporter and importer (`usbip-host`, `usbipd`, `vhci-hcd`, `usbip`) | Native local export requires installed tools and privileged setup, so it is outside the browser-only scope. The remote importer remains a possible prerequisite for a future browser-compatible solution.                                              |
| [usbipd-win](https://github.com/dorssel/usbipd-win)                                                                                                          | Windows exporter                                                           | Existing service, CLI, and driver. Its documented non-WSL receiver is a Linux USB/IP client. Sharing requires administrator setup and persists across reboots; disconnect alone must not be treated as revocation. Its installer adds a firewall rule. |
| [usbip-win2](https://github.com/vadimgrn/usbip-win2)                                                                                                         | Windows importer                                                           | Separate Windows virtual controller implementation. It does not replace the Windows exporter. Driver installation and device compatibility need independent validation.                                                                                |
| [VirtualHere](https://www.virtualhere.com/usb_client_software)                                                                                               | Native USB sharing ecosystem                                               | Requires native software and is outside the browser-only scope. It has separate deployment/licensing terms and no assumed universal USB/IP wire compatibility. Its macOS client explicitly excludes microphones/webcams.                               |
| [esptool-js](https://github.com/espressif/esptool-js), [DAP.js](https://github.com/ARMmbed/dapjs), [Tango/ya-webadb](https://github.com/yume-chan/ya-webadb) | Device-specific browser workflows                                          | Useful precedents for browser hardware access. They implement device protocols rather than making arbitrary devices available to remote native drivers.                                                                                                |

Native local exporters are excluded alternatives, not the recommended solution.
This comparison is not a supported-device matrix. Even native USB/IP
cannot promise every device: drivers, resets, composite interfaces, isochronous
traffic, bandwidth, and network latency need testing. The
[Linux USB/IP README](https://github.com/torvalds/linux/blob/master/tools/usb/usbip/README)
explicitly excludes exporting USB hubs. Keep macOS, mobile device
export, and containerized import uncommitted until a specific backend is proven.
For Docker, require host-kernel VHCI support and explicit exposure of the
resulting device into the agent container. Import and container access are
separate operations to validate.

## Paseo integration points

The plugin below uses existing settings, RPC, and process lifecycle support.
Core has no native USB/IP adapter. The public plugin registry and GitHub
issues, PRs, and Discussions were searched for USB/IP, WebUSB, WebHID, serial
ports, and passthrough before this implementation; no existing integration was
identified. [Discussion #7380](https://github.com/getpaseo/paseo/discussions/7380)
records the broader workflow. This is a dated search result, not a claim that
no external integration exists.

Adjacent work is [PR #6534](https://github.com/getpaseo/paseo/pull/6534), open at
the time of this investigation. Its proposed credit-windowed TCP tunnel routes
desktop browser traffic through the daemon's network. Review that transport
before designing another one. It is not in this checkout's base, does not export
USB devices, and does not provide the reverse path from a daemon-side importer
to a browser-local exporter.

| Existing surface                                                                 | Reuse and boundary                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Plugin settings](plugins.md#contribute-settings), `plugin-examples/settings`    | An optional device manager belongs under Settings → Plugins → the USB plugin. Reuse the host shell and named settings components.                                                                                                        |
| `packages/plugin/src/client/contracts.ts`, `server/contracts.ts`, `rpc.ts`       | Typed RPCs can carry discovery, attach, detach, and status operations. Server code runs on the daemon machine; it cannot invoke a browser-local native executable. There is no public generic duplex byte-stream API in these contracts. |
| `packages/server/src/server/authorization/operation-permissions.ts`              | Plugin RPC invocation currently requires `daemon.manage`. It is not a separate per-device grant.                                                                                                                                         |
| `packages/plugin/src/server/contracts.ts:9`                                      | Handler context exposes the plugin's Paseo API, not the originating browser principal or its disconnect lifecycle. Plugin handlers cannot assume caller-specific ownership from this context.                                            |
| [Plugin lifecycle](plugins.md), `packages/server/src/server/plugins/runtime.ts`  | Own importer resources in server cleanup. Browser unmount and plugin teardown are different events; a browser loss needs an explicit lease.                                                                                              |
| [Service proxy](service-proxy.md), `packages/server/src/server/service-proxy.ts` | Proxies daemon-side HTTP/WebSocket services. It is not a client-local exporter, reverse TCP tunnel, or authenticated USB transport. Public service URLs do not inherit daemon API authentication.                                        |
| [Relay security](../SECURITY.md#relay-threat-model)                              | Existing app/daemon messages can use Paseo's encrypted relay. External USB/IP traffic does not acquire that protection automatically.                                                                                                    |

Follow the existing [plugin runtime boundaries](plugins.md#sdk-import-boundaries).
Keep device libraries and Node APIs out of shared/client code. Adding a core
settings page would not provide the missing exporter, importer, or data path.

## Optional browser serial plugin

`plugin-examples/browser-serial` forwards one browser-approved USB serial device
to one TCP client on the selected Paseo host. It uses the existing plugin
settings shell and RPC transport, Node's TCP implementation, and the browser's
Web Serial API. It adds no runtime dependency, local native helper, kernel
driver, protocol change, or core settings route. Install it only on a trusted
host through the existing [plugin workflow](plugins.md#install-a-directory-source).

```mermaid
flowchart LR
  U[Local USB serial device] <-->|Web Serial| B[Paseo browser plugin]
  B <-->|Existing Paseo connection and plugin RPC| P[Host plugin]
  P <-->|Temporary loopback TCP byte stream| A[Agent tool]
```

The browser requires HTTPS or localhost, Web Serial support, and an explicit
selection. This example accepts USB serial ports; it does not implement a WebUSB
serial polyfill. Native mobile and Electron show an unavailable explanation.
Brave may require enabling its Web Serial flag. Choose a matching baud rate;
the session uses 8 data bits, no parity, one stop bit, and no hardware flow
control. Opening a serial port can reset some boards.

The plugin exposes an ephemeral `127.0.0.1` TCP endpoint on the daemon machine.
Agent tools can use a normal socket client without a serial-library dependency.
The connection belongs to the host's client plugin installation, so you can
switch to an agent and return to settings without losing the device, endpoint,
or chosen baud rate. Theme and layout changes also preserve the session. Keep
the browser tab open. Disconnect, tab reload/closure, plugin teardown, port
errors, or buffer overflow ends the device session. A host-tool disconnect
releases the TCP slot while preserving the selected device and endpoint. Browser loss expires the
host lease; there is no automatic reattachment. A new session requires selection
again. Browser permission revocation is separate from ending the session; the
screen offers Forget device when the browser provides that operation.

The raw TCP endpoint is available to processes that can reach the host's
loopback, including other local OS users. It has no TCP authentication; use only
a trusted machine. Browser RPC operations require the session's unpredictable
token in addition to Paseo's existing `daemon.manage` authority. The token does
not protect against local processes using the TCP endpoint. In Docker, loopback
belongs to the daemon's network namespace; the agent tool must run there too.
No public listener or discovery service is started.

Only one bridge and one TCP client are active per plugin installation. Give the
displayed endpoint to the agent that will own the connection. Concurrent clients
are rejected. To hand over, finish pending device commands and close that tool's
TCP connection, or choose **Release host tool** in the browser. Another agent can
then connect to the same endpoint without selecting the device again. Release
keeps the serial port open; it does not reset the device or isolate delayed
responses from the previous tool. Forcing release can truncate bytes still being
sent to the departing tool. Agents must coordinate command boundaries. The first
local process to connect after release owns the next slot.
**Disconnect** ends the whole device session. There is no machine-readable
endpoint discovery service.

Each byte direction has a bounded buffer; overflow ends the session instead of
silently dropping bytes. Device startup output is buffered while the first host
tool connects. No listener or timer is created before a session. An active idle
session uses bounded long polling and a separate lease heartbeat over existing RPCs.
The heartbeat keeps slow serial writes from expiring the host session without
reading ahead into an unbounded queue. This experiment is aimed
at low-bandwidth serial consoles, not high-rate USB streaming.

The endpoint carries raw bytes. It implements neither RFC 2217 nor a virtual
`/dev/tty`/COM port. Host tools cannot change baud rate, toggle DTR/RTS, or perform
USB control transfers through it. Do not advertise it as a general firmware
flasher: tools needing those controls or device re-enumeration need additional
protocol work and hardware testing.

## Plugin versus core decision

Keep serial forwarding in an optional plugin, following the
[contribution policy](../CONTRIBUTING.md). The existing extension points cover
the bounded use case without adding a shared UI or driver dependency. A core
USB manager cannot remove the browser's protected-interface restrictions.

Revisit core only if a demonstrated reusable transport or caller-identity gap
blocks a feasible plugin. Adjacent TCP tunnel work may support a future efficient
binary transport. A full USB/IP approach would still need browser hardware
access, USB request translation, and a remote importer. Native local exporters
and privileged installed apps remain outside the local browser-only scope.

## Validation and limits

The focused tests use typed synthetic serial hardware, real host TCP sockets,
and an injected clock for lease expiry. Browser integration exercises the real
settings UI, plugin loaders, controller, app/daemon RPC connection, and a real
tool process launched in a Paseo workspace terminal. Only the physical serial
device is replaced at the hardware port. No browser globals or transports are
monkey-patched.

Brave, native mobile devices, Electron hardware permission flows, and encrypted
relay transport have not been exercised for this feature.
Synthetic echo traffic proves the byte path, not device compatibility or
firmware-flashing support. No full USB/IP device enumeration is claimed.

Before expanding support, verify the actual device on each advertised browser
and OS pair, including permission refusal, unplug, reset, browser suspension,
host switching, plugin reload, and daemon loss. Confirm that serial stream locks
and owned host sockets are released. Measure idle/active CPU, RSS, throughput,
latency, and recovery time before making performance claims.
