import { Redirect } from "expo-router";
import { buildSessionsRoute } from "@/utils/host-routes";

export default function HostSessionsRoute() {
  // COMPAT(hostSessionsRoute): added 2026-06-11, remove after 2026-12-11.
  return <Redirect href={buildSessionsRoute()} />;
}
