import { useEffect, useState } from "react";
import {
  openProviderAccountForm,
  type ProviderAccountFormSnapshot,
} from "./provider-account-form-model";

export function useProviderAccountFormModel(snapshot: ProviderAccountFormSnapshot) {
  const [model] = useState(() => openProviderAccountForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyExistingProviderIds(snapshot.existingProviderIds);
  }, [model, snapshot.existingProviderIds]);

  return model;
}
