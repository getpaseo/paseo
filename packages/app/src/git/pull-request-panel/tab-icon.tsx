import { getForgeIconComponent } from "@/git/forge-icon";
import { getForgePresentation, type Forge } from "@/git/forge";

export function PullRequestTabIcon({
  forge,
  size,
  color,
}: {
  forge: Forge;
  size: number;
  color: string;
}) {
  const Icon = getForgeIconComponent(getForgePresentation(forge).icon);
  return <Icon size={size} color={color} />;
}
