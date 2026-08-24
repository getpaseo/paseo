import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";

export function useOpenAddProject(): (preferredHostId?: string) => void {
  return useAddProjectFlowStore((state) => state.open);
}
