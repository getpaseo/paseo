import type { DesktopCommandHandler } from "../../settings/desktop-settings-commands.js";
import type { SkillsController } from "./skills-controller.js";

export function createSkillsCommandHandlers({
  controller,
}: {
  controller: SkillsController;
}): Record<string, DesktopCommandHandler> {
  return {
    get_skills_status: () => controller.status(),
    install_skills: () => controller.install(),
    update_skills: () => controller.update(),
    uninstall_skills: () => controller.uninstall(),
    save_skills_selection: (args) => controller.save(args),
  };
}
