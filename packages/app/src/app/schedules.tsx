import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SchedulesScreen } from "@/screens/schedules-screen";
import { parseScheduleFocus } from "@/utils/host-routes";

export default function SchedulesRoute() {
  const params = useLocalSearchParams<{ serverId?: string; scheduleId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : undefined;
  const scheduleId = typeof params.scheduleId === "string" ? params.scheduleId : undefined;
  const focus = useMemo(() => parseScheduleFocus({ serverId, scheduleId }), [serverId, scheduleId]);

  return (
    <HostRouteBootstrapBoundary>
      <SchedulesScreen focus={focus} />
    </HostRouteBootstrapBoundary>
  );
}
