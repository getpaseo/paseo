# Running the daemon as a service

The desktop app starts its daemon when you open a window, and that daemon
outlives the app once started. Nothing starts it before then, so on a freshly
booted machine phone clients, browser clients, schedules, and the CLI have
nothing to talk to until someone logs in and opens the GUI.

`--daemon-only` runs the packaged app as a headless daemon host instead:

```
Paseo --daemon-only
```

No window is created and no display is needed. The app already re-execs its own
Electron binary with `ELECTRON_RUN_AS_NODE=1` to run the bundled daemon every
time it starts one; the flag runs that same daemon in the foreground and stays
alive alongside it, so a service manager can supervise it.

Because the daemon ships inside the app, the client and the daemon are one
artifact. There is no separate daemon install to keep in step, and an app update
replaces both halves at once.

## systemd

```ini
[Unit]
Description=Paseo daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/Applications/Paseo-x86_64.AppImage --daemon-only
EnvironmentFile=%h/.config/paseo/daemon.env
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

Run it as a user unit (`systemctl --user`). The daemon needs the user's home,
SSH agent, and agent CLIs, so a system unit is the wrong scope.

`systemctl stop` exits 0, and a daemon that dies on its own exits non-zero so
`Restart=` brings it back.

## Configuration

Configure it through the environment, the same variables the daemon reads
anywhere else — `PASEO_HOME`, `PASEO_LISTEN`, `PASEO_PASSWORD`.

**A unit's environment outranks the login shell.** The app inherits the login
shell's environment on startup so agents get the `PATH` a terminal would give
them, which matters more here than usual because a service at boot has no shell
to inherit from. Every `PASEO_*` variable the service manager passed in survives
that inheritance. Without it, a shell rc that exports `PASEO_HOME` for
interactive CLI use would move the daemon to a different home and take every
agent and project with it.

## What it is not

A `--daemon-only` process is not a desktop-managed daemon. It is not recorded as
`desktopManaged` in the PID lock, so a desktop app that later attaches to it
treats it as an external daemon: it will not stop it on quit and will not stop
it to install an app update. Set `manageBuiltInDaemon: false` in the desktop
app's settings so it attaches to this daemon rather than starting a second one.

The Chromium browser process still initializes — it is the service's main
process — and its zygote and network helpers stay resident with it. That costs a
few hundred MB of RSS beyond the daemon itself.
