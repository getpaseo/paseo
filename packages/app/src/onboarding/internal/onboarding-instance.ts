import { asyncStorageOnboardingCompletion } from "./completion-storage";
import { createOnboardingModel, type OnboardingModel } from "./model";

let instance: OnboardingModel | null = null;

/** The app's one setup model, created on first use so storage is read once per launch. */
export function getOnboardingModel(): OnboardingModel {
  instance ??= createOnboardingModel({ storage: asyncStorageOnboardingCompletion });
  return instance;
}
