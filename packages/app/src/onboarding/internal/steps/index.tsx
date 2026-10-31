import type { ProjectSuggestionsController } from "@/project-suggestions";
import type { OnboardingStepId } from "../model";
import { AppearanceStep } from "./appearance-step";
import { OrchestrationStep } from "./orchestration-step";
import { PhoneStep } from "./phone-step";
import { ProjectsStep } from "./projects-step";
import { ProvidersStep } from "./providers-step";

export function OnboardingStepContent({
  step,
  serverId,
  projectSuggestions,
  onFinish,
}: {
  step: OnboardingStepId;
  serverId: string;
  projectSuggestions: ProjectSuggestionsController;
  onFinish: () => void;
}) {
  switch (step) {
    case "appearance":
      return <AppearanceStep />;
    case "providers":
      return <ProvidersStep serverId={serverId} />;
    case "projects":
      return <ProjectsStep serverId={serverId} suggestions={projectSuggestions} />;
    case "orchestration":
      return <OrchestrationStep serverId={serverId} />;
    case "phone":
      return <PhoneStep serverId={serverId} onFinish={onFinish} />;
  }
}
