import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { GOAL_PERMISSION_POLICIES } from "@getpaseo/protocol/goal/config-bounds";
import {
  GOAL_FORM_MEMORY_VERSION,
  migrateGoalFormMemory,
  type GoalFormMemory,
} from "@/goals/goal-form-memory";
import { DAEMON_GOAL_SETTINGS } from "@/goals/goal-settings";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const GoalSettingsSchema = z.strictObject({
  maxParallel: z.number(),
  maxAttempts: z.number(),
  maxReworkRounds: z.number(),
  maxTasks: z.number(),
  maxRuns: z.number(),
  runTimeoutMinutes: z.number(),
  goalTimeoutMinutes: z.number(),
  retryBackoffSeconds: z.number(),
  // Absent from memory written before the wait limit existed.
  userWaitMinutes: z.number().default(DAEMON_GOAL_SETTINGS.userWaitMinutes),
  autoApprovePlan: z.boolean(),
  requireHumanApproval: z.boolean(),
  onPermissionRequest: z.enum(GOAL_PERMISSION_POLICIES),
  notifyLead: z.boolean(),
});

const GoalFormMemorySchema = z.strictObject({
  cwd: z.string(),
  leadProvider: z.string(),
  defaultProvider: z.string(),
  reviewProvider: z.string().nullable(),
  testCommand: z.string().nullable(),
  allowedProviders: z.array(z.string()),
  settings: GoalSettingsSchema,
  // Absent from memory written before goal thinking.
  thinking: z
    .strictObject({
      lead: z.string().optional(),
      worker: z.string().optional(),
      reviewer: z.string().optional(),
      verifier: z.string().optional(),
    })
    .optional(),
}) satisfies z.ZodType<GoalFormMemory>;

export const GoalFormMemoryPersistedSchema = z.strictObject({
  byServer: z.record(z.string(), GoalFormMemorySchema),
});

interface GoalFormMemoryStoreState {
  /** Your last managed goal on each host. */
  byServer: Record<string, GoalFormMemory>;
  remember: (serverId: string, memory: GoalFormMemory) => void;
}

/** Seeds the next goal on a host from the last one you created there. */
export const useGoalFormMemoryStore = create<GoalFormMemoryStoreState>()(
  persist(
    (set) => ({
      byServer: {},
      remember: (serverId, memory) => {
        set((state) => ({ byServer: { ...state.byServer, [serverId]: memory } }));
      },
    }),
    {
      name: "goal-form-memory",
      storage: createValidatedPersistStorage(AsyncStorage, GoalFormMemoryPersistedSchema),
      partialize: (state) => ({ byServer: state.byServer }),
      version: GOAL_FORM_MEMORY_VERSION,
      // Only the meaning of a remembered `fail` changed; see migrateGoalFormMemory.
      migrate: (persisted, version) => {
        const parsed = GoalFormMemoryPersistedSchema.safeParse(persisted);
        return {
          byServer: parsed.success ? migrateGoalFormMemory(parsed.data.byServer, version) : {},
        };
      },
    },
  ),
);
