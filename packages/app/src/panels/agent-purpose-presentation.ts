export function buildAgentPurposePresentation(input: {
  label: string | null;
  summary: string | null;
  providerLabel: string;
}): { subtitle: string; tooltip: string } {
  const fallback = `${input.providerLabel} agent`;
  const tooltipTitle = input.label ?? fallback;
  if (!input.summary) {
    return { subtitle: fallback, tooltip: tooltipTitle };
  }
  return {
    subtitle: input.summary,
    tooltip: `${tooltipTitle}\n${input.summary}`,
  };
}
