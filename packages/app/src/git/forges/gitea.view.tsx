import { GiteaIcon } from "@/components/icons/gitea-icon";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const giteaForgeView = {
  id: "gitea",
  icon: GiteaIcon,
  brandColor: {
    light: "#609926",
    dark: "#609926",
  },
} satisfies ClientForgeViewModule;
