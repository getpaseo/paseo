import { useMemo, useState, useCallback } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { inertArtifactHtml } from "./html-policy";
import { styles } from "./styles";
const FRAME_STYLE = { width: "100%", height: 360, border: 0 } as const;
export function HtmlArtifact({ html }: { html: string }) {
  const { t } = useTranslation();
  const safe = useMemo(() => inertArtifactHtml(html), [html]);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return (
    <View style={styles.content}>
      {safe.scripted ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("interactive.scriptBlocked")}
        </Text>
      ) : null}
      <iframe
        key={revision}
        title={t("interactive.artifact")}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={safe.html}
        style={FRAME_STYLE}
      />
      <Button size="sm" variant="ghost" onPress={reload}>
        {t("interactive.reload")}
      </Button>
    </View>
  );
}
