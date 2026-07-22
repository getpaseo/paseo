import { useEffect, useState } from "react";
import { openProjectAppearanceForm, type ProjectAppearanceFormSnapshot } from "./form";

export function useProjectAppearanceForm(snapshot: ProjectAppearanceFormSnapshot) {
  const [model] = useState(() => openProjectAppearanceForm(snapshot));

  useEffect(() => () => model.close(), [model]);

  return model;
}
