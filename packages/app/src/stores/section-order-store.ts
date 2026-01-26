import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface SectionOrderState {
  /** Ordered array of project keys. Projects not in this list appear at the end in their natural order. */
  projectOrder: string[];

  /** Set the full order of project keys */
  setProjectOrder: (order: string[]) => void;

  /** Move a project to a new index */
  moveProject: (fromIndex: number, toIndex: number) => void;
}

export const useSectionOrderStore = create<SectionOrderState>()(
  persist(
    (set) => ({
      projectOrder: [],

      setProjectOrder: (order) => set({ projectOrder: order }),

      moveProject: (fromIndex, toIndex) =>
        set((state) => {
          const newOrder = [...state.projectOrder];
          const [removed] = newOrder.splice(fromIndex, 1);
          if (removed !== undefined) {
            newOrder.splice(toIndex, 0, removed);
          }
          return { projectOrder: newOrder };
        }),
    }),
    {
      name: "section-order",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
      }),
    }
  )
);

/**
 * Sort project groups according to persisted order.
 * Projects not in the persisted order appear at the end in their original order.
 */
export function sortProjectsByStoredOrder<T extends { projectKey: string }>(
  groups: T[],
  storedOrder: string[]
): T[] {
  if (storedOrder.length === 0) {
    return groups;
  }

  const orderMap = new Map(storedOrder.map((key, index) => [key, index]));

  return [...groups].sort((a, b) => {
    const aIndex = orderMap.get(a.projectKey);
    const bIndex = orderMap.get(b.projectKey);

    // Both have stored order - sort by stored order
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex;
    }

    // Only a has stored order - a comes first
    if (aIndex !== undefined) {
      return -1;
    }

    // Only b has stored order - b comes first
    if (bIndex !== undefined) {
      return 1;
    }

    // Neither has stored order - maintain original order (stable sort)
    return 0;
  });
}
