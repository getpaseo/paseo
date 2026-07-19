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
    model.applyPreferences(snapshot.defaults.preferences);
  }, [model, snapshot.hosts, snapshot.defaults.preferences, snapshot.defaults.projectTargets]);

  return model;
}
