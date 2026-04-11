export class PendingOpenProjectStore {
  private readonly pendingPathByWebContentsId = new Map<number, string>();

  set(webContentsId: number, projectPath: string | null | undefined): void {
    const normalizedPath = this.normalizeProjectPath(projectPath);
    if (!normalizedPath) {
      this.pendingPathByWebContentsId.delete(webContentsId);
      return;
    }

    this.pendingPathByWebContentsId.set(webContentsId, normalizedPath);
  }

  take(webContentsId: number): string | null {
    const projectPath = this.pendingPathByWebContentsId.get(webContentsId) ?? null;
    this.pendingPathByWebContentsId.delete(webContentsId);
    return projectPath;
  }

  delete(webContentsId: number): void {
    this.pendingPathByWebContentsId.delete(webContentsId);
  }

  private normalizeProjectPath(projectPath: string | null | undefined): string | null {
    if (typeof projectPath !== "string") {
      return null;
    }

    const trimmedPath = projectPath.trim();
    return trimmedPath ? trimmedPath : null;
  }
}
