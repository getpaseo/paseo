export function generateAgentProfileId(): string {
  return `agent_profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
