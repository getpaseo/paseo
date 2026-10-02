import { Redirect } from "expo-router";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export default function LegacyPluginRoute() {
  return <Redirect href={buildOpenProjectRoute()} />;
}
