import { useEffect, useState } from "react";
import {
  openProjectAppearanceForm,
  type ProjectAppearanceFormSnapshot,
} from "./project-appearance-form-model";

export function useProjectAppearanceFormModel(snapshot: ProjectAppearanceFormSnapshot) {
  const [model] = useState(() => openProjectAppearanceForm(snapshot));

  useEffect(() => () => model.close(), [model]);

  return model;
}
