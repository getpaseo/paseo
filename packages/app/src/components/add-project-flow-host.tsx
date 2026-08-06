import { AddProjectFlow } from "@/components/add-project-flow";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";

export function AddProjectFlowHost() {
  const request = useAddProjectFlowStore((state) => state.request);
  const close = useAddProjectFlowStore((state) => state.close);

  if (!request) return null;

  return <AddProjectFlow key={request.id} request={request} onClose={close} />;
}
