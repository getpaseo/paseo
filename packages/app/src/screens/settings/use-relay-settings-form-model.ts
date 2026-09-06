import { useEffect, useState } from "react";
import {
  createRelaySettingsFormModel,
  type RelaySettingsValues,
} from "./relay-settings-form-model";

export function useRelaySettingsFormModel(input: {
  initialValues: RelaySettingsValues;
  overrideControlledPaths: readonly string[];
}) {
  const [model] = useState(() => createRelaySettingsFormModel(input));

  useEffect(() => () => model.close(), [model]);

  return model;
}
