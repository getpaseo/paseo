import type { DaemonConfigStore, MutableDaemonConfig } from "../daemon-config-store.js";

export interface BrowserToolsPolicy {
  isEnabled(): boolean;
}

export class DaemonConfigBrowserToolsPolicy implements BrowserToolsPolicy {
  public constructor(private readonly configStore: Pick<DaemonConfigStore, "get">) {}

  public isEnabled(): boolean {
    return readBrowserToolsEnabled(this.configStore.get());
  }
}

function readBrowserToolsEnabled(config: MutableDaemonConfig): boolean {
  const browserTools = config.browserTools;
  if (typeof browserTools !== "object" || browserTools === null || Array.isArray(browserTools)) {
    return false;
  }
  return browserTools.enabled === true;
}
