import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import type { OnboardingCompletionStorage } from "./model";

export const ONBOARDING_STORAGE_KEY = "@paseo:onboarding";

const OnboardingRecordSchema = z.object({ completedAt: z.string() });

export const asyncStorageOnboardingCompletion: OnboardingCompletionStorage = {
  async isCompleted() {
    const record = await readValidatedJson(
      AsyncStorage,
      ONBOARDING_STORAGE_KEY,
      OnboardingRecordSchema,
    );
    return record !== null;
  },
  async markCompleted() {
    await AsyncStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ completedAt: new Date().toISOString() }),
    );
  },
};
