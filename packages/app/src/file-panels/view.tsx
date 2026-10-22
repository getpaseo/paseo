import type { FilePanel, BuiltinFilePanelProps } from "./panels";
import { BuiltinFilePanelView } from "./builtin";
import { PluginFilePanelHost } from "./plugin-host";

/** Renders a file panel as the file tab's body. The panel owns its loading, errors and saving. */
export function FilePanelView({ panel, ...props }: BuiltinFilePanelProps & { panel: FilePanel }) {
  if (panel.builtin) return <BuiltinFilePanelView {...props} panel={panel} />;
  return <PluginFilePanelHost {...props} panel={panel} />;
}
