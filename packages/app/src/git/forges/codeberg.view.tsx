import { CodebergIcon } from "@/components/icons/codeberg-icon";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const codebergForgeView = {
  id: "codeberg",
  icon: CodebergIcon,
  brandColor: {
    light: "#2185D0",
    dark: "#2185D0",
  },
} satisfies ClientForgeViewModule;
