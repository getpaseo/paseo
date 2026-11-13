import type { CommandLine } from "electron";

interface DesktopGraphicsOptions {
  platform: NodeJS.Platform;
  display: string | undefined;
  argv: readonly string[];
  commandLine: Pick<CommandLine, "appendSwitch">;
}

export function configureDesktopGraphics({
  platform,
  display,
  commandLine,
  argv,
}: DesktopGraphicsOptions): void {
  const hasExplicitBackend = argv.some((argument) =>
    /^(--ozone-platform|--ozone-platform-hint)(=|$)/.test(argument),
  );
  if (platform !== "linux" || !display || hasExplicitBackend) return;

  // Native Wayland stops producing frames for hidden windows, even with
  // background throttling disabled. XWayland keeps background browser tools usable.
  commandLine.appendSwitch("ozone-platform", "x11");
}
