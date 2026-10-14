import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
interface TodoView {
  open: boolean;
}
interface TodoViews {
  views: Record<string, TodoView>;
  setView(key: string, view: TodoView): void;
}
export const useTodoViews = create<TodoViews>()(
  persist(
    (set) => ({
      views: {},
      setView: (key, view) => set((state) => ({ views: { ...state.views, [key]: view } })),
    }),
    {
      name: "workspace-todo-views",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        z.object({
          views: z.record(
            z.string(),
            z.object({
              open: z.boolean(),
            }),
          ),
        }),
      ),
      partialize: (state) => ({ views: state.views }),
    },
  ),
);
