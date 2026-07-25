import { useGlobalWorkspacePinAction } from "@/hooks/use-global-workspace-pin-action";

// Headless host for the pin shortcut. The hook subscribes to the active workspace's pin state, so
// it lives in its own component rather than the root layout — otherwise every pin toggle would
// re-render the whole app shell.
export function WorkspacePinShortcutHandler() {
  useGlobalWorkspacePinAction();
  return null;
}
