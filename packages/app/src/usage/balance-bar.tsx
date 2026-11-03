import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  formatAmount,
  formatProviderUsageLabel,
  formatResetLabel,
  formatResetTime,
} from "./format";
import { UsageMeter } from "./meter";
import { UsageResetLine } from "./reset-line";
import type { UsageBalance } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

interface ResolvedBalance {
  amountText: string;
  usedPct: number | null;
}

function resolveBalance({
  balance,
  t,
  locale,
}: {
  balance: UsageBalance;
  t: TFunction;
  locale?: string;
}): ResolvedBalance {
  const { used, remaining, limit, unit } = balance;
  const format = (value: number) => formatAmount(value, unit, locale);
  if (limit != null && limit > 0) {
    const usedAmount = used ?? (remaining != null ? limit - remaining : null);
    const usedPct = usedAmount != null ? (usedAmount / limit) * 100 : null;
    const usedText = usedAmount != null ? format(usedAmount) : "—";
    return { amountText: `${usedText} / ${format(limit)}`, usedPct };
  }
  if (remaining != null) {
    return {
      amountText: t("providerUsage.values.remaining", { amount: format(remaining) }),
      usedPct: null,
    };
  }
  if (used != null) {
    return { amountText: format(used), usedPct: null };
  }
  return { amountText: "—", usedPct: null };
}

export function UsageBalanceBar({
  balance,
  retained = false,
}: {
  balance: UsageBalance;
  retained?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const now = useRelativeTimeTick({ enabled: balance.resetsAt != null });
  const { amountText, usedPct } = resolveBalance({ balance, t, locale: i18n.resolvedLanguage });
  const tone = balance.tone ?? "default";
  const resetLabel = formatResetLabel(balance.resetsAt, retained, now, t);
  const resetTime = formatResetTime(balance.resetsAt, now, t);

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {formatProviderUsageLabel(balance.id, balance.label, t)}
        </Text>
        <Text
          style={styles.amount}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID={`provider-usage-balance-${balance.id}-value`}
        >
          {amountText}
        </Text>
      </View>
      {usedPct != null ? <UsageMeter percent={usedPct} tone={tone} /> : null}
      <UsageResetLine
        countdown={resetLabel}
        exactTime={resetTime}
        testID={`provider-usage-balance-${balance.id}-reset`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 3,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  amount: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
