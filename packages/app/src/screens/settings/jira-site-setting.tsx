import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { normalizeJiraSite } from "@/utils/jira";
import { useJiraSite, useJiraSiteStore } from "@/stores/jira-site-store";

export function JiraSiteSetting() {
  const { t } = useTranslation();
  const site = useJiraSite();
  const setJiraSite = useJiraSiteStore((state) => state.setJiraSite);
  const [draft, setDraft] = useState<string | null>(null);
  const isBlank = draft === null || draft.trim() === "";
  const normalized = isBlank ? null : normalizeJiraSite(draft);
  const isInvalid = !isBlank && normalized === null;

  const commit = useCallback(() => {
    if (draft === null || isInvalid) return;
    setJiraSite(normalized);
    setDraft(null);
  }, [draft, isInvalid, normalized, setJiraSite]);

  return (
    <Field
      label={t("leitstand.jiraSite.label")}
      hint={t("leitstand.jiraSite.hint")}
      error={isInvalid ? t("leitstand.jiraSite.invalid") : null}
      testID="leitstand-jira-site"
    >
      <FormTextInput
        initialValue={site ?? ""}
        resetKey={site ?? ""}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        placeholder={t("leitstand.jiraSite.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel={t("leitstand.jiraSite.label")}
        testID="leitstand-jira-site-input"
      />
    </Field>
  );
}
