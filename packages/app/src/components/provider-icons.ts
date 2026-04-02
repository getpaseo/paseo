import { Bot } from "lucide-react-native";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";

const PROVIDER_ICONS: Record<string, typeof Bot> = {
  claude: ClaudeIcon as unknown as typeof Bot,
  "claude-acp": ClaudeIcon as unknown as typeof Bot,
  codex: CodexIcon as unknown as typeof Bot,
  copilot: CopilotIcon as unknown as typeof Bot,
};

export function getProviderIcon(provider: string): typeof Bot {
  return PROVIDER_ICONS[provider] ?? Bot;
}
