import { i18n } from "@/i18n/i18next";

const LABEL_KEYS: Record<string, string> = {
  five_hour: "providerUsage.labels.session",
  session: "providerUsage.labels.session",
  weekly: "providerUsage.labels.weekly",
  weekly_opus: "providerUsage.labels.weeklyOpus",
  weekly_omelette: "providerUsage.labels.weeklyOmelette",
  code_review: "providerUsage.labels.codeReview",
  credits: "providerUsage.labels.credits",
  monthly_credits: "providerUsage.labels.monthlyCredits",
  extra_usage: "providerUsage.labels.extraUsage",
  coding_usage: "providerUsage.labels.codingUsage",
  plan_usage: "providerUsage.labels.planUsage",
  total_usage: "providerUsage.labels.totalUsage",
  api_usage: "providerUsage.labels.apiUsage",
  auto_usage: "providerUsage.labels.firstPartyModels",
  bonus_spend: "providerUsage.labels.bonusSpend",
  account_email: "providerUsage.labels.accountEmail",
  account_name: "providerUsage.labels.account",
  account_type: "providerUsage.labels.accountType",
  reset: "providerUsage.labels.quotaReset",
  status: "providerUsage.labels.status",
  valid: "providerUsage.labels.valid",
  purchase_time: "providerUsage.labels.purchased",
};

const GROK_NETWORK_ERROR_MARKER = "Couldn't reach Grok billing API";

export function localizeProviderUsageLabel(id: string, fallback: string): string {
  const key = LABEL_KEYS[id];
  return key ? i18n.t(key) : fallback;
}

export function localizeProviderUsageError(message: string): string {
  if (message.includes(GROK_NETWORK_ERROR_MARKER) || message.includes("cli-chat-proxy.grok.com")) {
    return i18n.t("providerUsage.errors.grokNetwork");
  }
  return message;
}
