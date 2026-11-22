import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { Alert } from "@/components/ui/alert";
import { buildOmpFormDocument } from "./omp-form-document";
import { OmpFormFrame, type OmpFormFrameProps } from "./omp-form-frame";

interface OmpFormCardProps {
  html: string;
  title: string;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
  responseError: string | null;
}

export function OmpFormCard({
  html,
  title,
  onRespond,
  isResponding,
  responseError,
}: OmpFormCardProps) {
  const { t } = useTranslation();
  const document = useMemo(
    () =>
      buildOmpFormDocument(html, {
        submit: t("message.question.submit"),
        cancel: t("common.actions.cancel"),
        other: t("message.question.otherPlaceholder"),
        unavailable: "Cannot display this OMP form.",
      }),
    [html, t],
  );
  const onAnswer = useCallback<OmpFormFrameProps["onAnswer"]>(
    (message) => {
      if (isResponding) return;
      if ("data" in message) onRespond({ behavior: "allow", updatedInput: { data: message.data } });
      else onRespond({ behavior: "deny" });
    },
    [isResponding, onRespond],
  );
  return (
    <View style={styles.card} pointerEvents={isResponding ? "none" : "auto"}>
      <OmpFormFrame document={document} title={title} onAnswer={onAnswer} />
      {responseError ? <Alert variant="error" description={responseError} size="sm" /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
}));
