# Managed desktop hosts

Paseo Desktop can enroll direct daemon connections from a JSON file instead of requiring each host
to be added through Settings. This is intended for machine-managed configuration such as agenix,
sops-nix, or another secret deployment system.

The default path is `$XDG_CONFIG_HOME/paseo/managed-hosts.json`, falling back to
`~/.config/paseo/managed-hosts.json`. Set `PASEO_MANAGED_HOSTS_FILE` on the desktop process to use a
different path.

```json
{
  "version": 1,
  "hosts": [
    {
      "label": "Ryzen",
      "endpoint": "ryzen-shine:6767",
      "password": "direct-connection-password"
    },
    {
      "label": "Mac mini",
      "endpoint": "mac-demarco-mini:443",
      "useTls": true,
      "password": "another-password"
    }
  ]
}
```

At startup, Desktop reads the file in Electron's main process and sends the validated registry
through the sandboxed preload bridge. The app probes each direct endpoint, learns the daemon's
authoritative server ID, and merges it through the normal host registry path. An unavailable host is
retried until its first successful enrollment; normal host reconnection owns subsequent outages.
The presence of at least one valid managed host suppresses the browser-style `localhost:6767`
fallback. Desktop-managed local daemon bootstrap is unchanged.

Managed entries currently become ordinary saved host connections after the first successful probe.
That means direct passwords are persisted in the app's AsyncStorage just like passwords entered in
the Add Host form. Encrypting the source file protects configuration at rest in the configuration
repository, but it does not turn AsyncStorage into keychain-backed storage.

Use stable DNS names when possible. Tailscale MagicDNS names work well because the registry does not
need to change when a machine's Tailscale IP changes. Daemons exposed on a tailnet should still use
Paseo password authentication and firewall the daemon port to the Tailscale interface.
