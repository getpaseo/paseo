export interface WorkspaceRowPress {
  cancelled: boolean;
  isAvailable(): boolean;
  acknowledge(): void;
  navigate(): void;
}

export function acceptWorkspaceRowPress(press: WorkspaceRowPress): boolean {
  if (press.cancelled || !press.isAvailable()) return false;
  press.acknowledge();
  press.navigate();
  return true;
}
