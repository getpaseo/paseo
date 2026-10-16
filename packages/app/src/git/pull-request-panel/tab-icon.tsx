import { getForgeIconComponent } from "@/git/forge-icon";
import { getForgePresentation, type Forge } from "@/git/forge";
import { useClientForgeHost } from "@/git/client-forge-registry";

export function PullRequestTabIcon({
  forge,
  serverId,
  size,
  color,
}: {
  forge: Forge;
  serverId: string;
  size: number;
  color: string;
}) {
  const host = useClientForgeHost(serverId);
  const Icon = getForgeIconComponent(getForgePresentation(forge, host).icon, host);
  return <Icon size={size} color={color} />;
}
