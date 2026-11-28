import type { DaemonConfigStore } from "../daemon-config-store.js";
import { resolveDaemonToolsFromMutableConfig } from "../tools-config.js";

export interface BrowserToolsPolicy {
  isEnabled(): boolean;
}

export class DaemonConfigBrowserToolsPolicy implements BrowserToolsPolicy {
  public constructor(private readonly configStore: Pick<DaemonConfigStore, "get">) {}

  public isEnabled(): boolean {
    const tools = resolveDaemonToolsFromMutableConfig(this.configStore.get());
    return tools.enabled && tools.groups.browser;
  }
}
