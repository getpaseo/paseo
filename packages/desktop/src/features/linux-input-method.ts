import { spawnSync } from "node:child_process";

interface LinuxInputMethodOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function configureLinuxInputMethod({
  env = process.env,
  platform = process.platform,
}: LinuxInputMethodOptions = {}): boolean {
  if (platform !== "linux" || env.IBUS_USE_PORTAL !== undefined) {
    return false;
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    return false;
  }

  const result = spawnSync(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      "org.freedesktop.portal.IBus",
    ],
    { env, encoding: "utf8", timeout: 1_000 },
  );
  if (result.status !== 0 || result.stdout.trim() !== "(true,)") {
    return false;
  }

  // libibus watches the portal's D-Bus owner and reconnects when it returns.
  // This also avoids cached private socket paths removed by cache cleanup.
  env.IBUS_USE_PORTAL = "1";
  return true;
}
