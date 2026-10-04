import { ShieldAlert } from "lucide-react";

export function PluginsTrustNote() {
  return (
    <p className="inline-flex items-start gap-2 text-xs text-extra-muted-foreground">
      <ShieldAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
      Plugins run unsandboxed on your machine. Read the source before you install.
    </p>
  );
}
