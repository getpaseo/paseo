export interface BrowserWorkspaceRegistration {
  browserId: string;
  workspaceId: string;
}

export class PaseoBrowserWebviewRegistry {
  private readonly browserIdsByWebContentsId = new Map<number, string>();
  private readonly webContentsIdsByBrowserId = new Map<string, number>();
  private readonly workspaceIdsByBrowserId = new Map<string, string>();
  private readonly activeBrowserIdsByWorkspaceId = new Map<string, string>();

  public registerWebContents(input: { webContentsId: number; browserId: string }): void {
    const previousWebContentsId = this.webContentsIdsByBrowserId.get(input.browserId) ?? null;
    if (previousWebContentsId !== null && previousWebContentsId !== input.webContentsId) {
      this.browserIdsByWebContentsId.delete(previousWebContentsId);
    }

    this.browserIdsByWebContentsId.set(input.webContentsId, input.browserId);
    this.webContentsIdsByBrowserId.set(input.browserId, input.webContentsId);
  }

  public unregisterWebContents(webContentsId: number): void {
    const browserId = this.browserIdsByWebContentsId.get(webContentsId) ?? null;
    if (!browserId) {
      return;
    }

    this.browserIdsByWebContentsId.delete(webContentsId);
    if (this.webContentsIdsByBrowserId.get(browserId) !== webContentsId) {
      return;
    }

    this.webContentsIdsByBrowserId.delete(browserId);
    this.workspaceIdsByBrowserId.delete(browserId);
    this.deleteActiveBrowserReferences(browserId);
  }

  public getBrowserIdForWebContents(webContentsId: number): string | null {
    return this.browserIdsByWebContentsId.get(webContentsId) ?? null;
  }

  public getWebContentsIdForBrowser(browserId: string): number | null {
    return this.webContentsIdsByBrowserId.get(browserId) ?? null;
  }

  public listBrowserIds(): string[] {
    return Array.from(this.webContentsIdsByBrowserId.keys()).sort();
  }

  public registerWorkspace(input: BrowserWorkspaceRegistration): void {
    this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
  }

  public unregisterBrowser(browserId: string): void {
    const webContentsId = this.webContentsIdsByBrowserId.get(browserId) ?? null;
    if (webContentsId !== null) {
      this.browserIdsByWebContentsId.delete(webContentsId);
      this.webContentsIdsByBrowserId.delete(browserId);
    }
    this.workspaceIdsByBrowserId.delete(browserId);
    this.deleteActiveBrowserReferences(browserId);
  }

  public getWorkspaceId(browserId: string): string | null {
    return this.workspaceIdsByBrowserId.get(browserId) ?? null;
  }

  public listBrowserIdsForWorkspace(workspaceId: string): string[] {
    return this.listBrowserIds().filter(
      (browserId) => this.workspaceIdsByBrowserId.get(browserId) === workspaceId,
    );
  }

  public setWorkspaceActiveBrowser(input: { workspaceId: string; browserId: string | null }): void {
    if (input.browserId) {
      this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
      this.activeBrowserIdsByWorkspaceId.delete(input.workspaceId);
      this.activeBrowserIdsByWorkspaceId.set(input.workspaceId, input.browserId);
      return;
    }
    this.activeBrowserIdsByWorkspaceId.delete(input.workspaceId);
  }

  public getWorkspaceActiveBrowserId(workspaceId: string): string | null {
    return this.activeBrowserIdsByWorkspaceId.get(workspaceId) ?? null;
  }

  public getMostRecentWorkspaceActiveBrowserId(): string | null {
    return Array.from(this.activeBrowserIdsByWorkspaceId.values()).at(-1) ?? null;
  }

  private deleteActiveBrowserReferences(browserId: string): void {
    for (const [workspaceId, activeBrowserId] of this.activeBrowserIdsByWorkspaceId) {
      if (activeBrowserId === browserId) {
        this.activeBrowserIdsByWorkspaceId.delete(workspaceId);
      }
    }
  }
}
