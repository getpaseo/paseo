import { ForgejoIcon } from "@/components/icons/forgejo-icon";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const forgejoForgeView = {
  id: "forgejo",
  icon: ForgejoIcon,
  brandColor: {
    light: "#FB923C",
    dark: "#FB923C",
  },
} satisfies ClientForgeViewModule;
