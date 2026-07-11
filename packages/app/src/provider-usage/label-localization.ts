export interface ProviderUsageLabels {
  session: string;
  weekly: string;
  credits: string;
}

export function localizeProviderUsageLabel(label: string, labels: ProviderUsageLabels): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "session") return labels.session;
  if (normalized === "weekly") return labels.weekly;
  if (normalized === "credits") return labels.credits;
  return label;
}
