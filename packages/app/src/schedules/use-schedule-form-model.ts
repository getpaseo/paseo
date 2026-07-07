import { useEffect, useState } from "react";
import { openScheduleForm, type ScheduleFormSnapshot } from "./schedule-form-model";

export function useScheduleFormModel(snapshot: ScheduleFormSnapshot) {
  const [model] = useState(() => openScheduleForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
    model.applyProjectTargets(snapshot.defaults.projectTargets);
  }, [model, snapshot.hosts, snapshot.defaults.projectTargets]);

  return model;
}
