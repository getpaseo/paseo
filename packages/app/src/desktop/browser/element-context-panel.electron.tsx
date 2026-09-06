import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { TFunction } from "i18next";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Check, SlidersHorizontal, Undo2, X } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import type {
  BrowserElementChange,
  BrowserElementContext,
  BrowserElementField,
  BrowserElementJson,
} from "@/desktop/browser/element-context";
import {
  browserElementValuesEqual,
  isBrowserElementFieldValueValid,
} from "@/desktop/browser/element-context-field-value";
import {
  ElementContextFields,
  type BrowserElementFieldGroup,
} from "@/desktop/browser/element-context-fields.electron";
import { elementContextPanelStyles as styles } from "@/desktop/browser/element-context-panel.styles.electron";
import type { Theme } from "@/styles/theme";
import { dispatchTopWebOverlayKeyDown } from "@/lib/overlay-root";

interface ElementContextPanelProps {
  context: BrowserElementContext;
  elementText: string;
  commentPlaceholder: string;
  submitLabel: string;
  cancelLabel: string;
  resetLabel: string;
  adjustLabel: string;
  onSubmit: (input: { comment: string; changes: BrowserElementChange[] }) => void;
  onPreview: (changes: BrowserElementChange[]) => void;
  onCancel: () => void;
  overlayStyle?: StyleProp<ViewStyle>;
  panelStyle?: StyleProp<ViewStyle>;
}

interface ElementContextPanelState {
  comment: string;
  detailsOpen: boolean;
  values: Record<string, BrowserElementJson>;
}

type ElementContextPanelAction =
  | { type: "comment-changed"; comment: string }
  | { type: "details-opened" }
  | { type: "details-closed" }
  | { type: "field-changed"; fieldId: string; value: BrowserElementJson }
  | { type: "changes-reset"; values: Record<string, BrowserElementJson> };

function initialFieldValues(fields: readonly BrowserElementField[]) {
  return Object.fromEntries(fields.map((field) => [field.id, field.value]));
}

function createInitialPanelState(context: BrowserElementContext): ElementContextPanelState {
  return {
    comment: "",
    detailsOpen: false,
    values: initialFieldValues(context.fields),
  };
}

function elementContextPanelReducer(
  state: ElementContextPanelState,
  action: ElementContextPanelAction,
): ElementContextPanelState {
  switch (action.type) {
    case "comment-changed":
      return { ...state, comment: action.comment };
    case "details-opened":
      return { ...state, detailsOpen: true };
    case "details-closed":
      return { ...state, detailsOpen: false };
    case "field-changed":
      return { ...state, values: { ...state.values, [action.fieldId]: action.value } };
    case "changes-reset":
      return { ...state, values: action.values };
  }
}

function genericFieldLabel(fieldId: string, t: TFunction): string {
  switch (fieldId) {
    case "checked":
      return t("workspace.browser.annotate.fields.checked");
    case "value":
      return t("workspace.browser.annotate.fields.value");
    case "text":
      return t("workspace.browser.annotate.fields.text");
    case "alt":
      return t("workspace.browser.annotate.fields.alternativeText");
    case "color":
      return t("workspace.browser.annotate.fields.textColor");
    case "background-color":
      return t("workspace.browser.annotate.fields.background");
    case "font-family":
      return t("workspace.browser.annotate.fields.font");
    case "font-size":
      return t("workspace.browser.annotate.fields.fontSize");
    case "font-weight":
      return t("workspace.browser.annotate.fields.fontWeight");
    case "opacity":
      return t("workspace.browser.annotate.fields.opacity");
    default:
      return fieldId;
  }
}

export function ElementContextPanel({
  context,
  elementText,
  commentPlaceholder,
  submitLabel,
  cancelLabel,
  resetLabel,
  adjustLabel,
  onSubmit,
  onPreview,
  onCancel,
  overlayStyle,
  panelStyle,
}: ElementContextPanelProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(
    elementContextPanelReducer,
    context,
    createInitialPanelState,
  );
  const { comment, detailsOpen, values } = state;
  const fields = useMemo(
    () =>
      context.provider.id === "paseo.dom"
        ? context.fields.map((field) => ({ ...field, label: genericFieldLabel(field.id, t) }))
        : context.fields,
    [context.fields, context.provider.id, t],
  );
  const groups = useMemo<BrowserElementFieldGroup[]>(() => {
    const result = new Map<string, BrowserElementField[]>();
    for (const field of fields) {
      const group = field.group ?? "Properties";
      result.set(group, [...(result.get(group) ?? []), field]);
    }
    return [...result.entries()];
  }, [fields]);
  const changes = useMemo<BrowserElementChange[]>(
    () =>
      context.fields.flatMap((field) => {
        const next = values[field.id] ?? null;
        return browserElementValuesEqual(field.value, next)
          ? []
          : [{ fieldId: field.id, path: field.path, from: field.value, to: next }];
      }),
    [context.fields, values],
  );
  const previewChanges = useMemo(
    () =>
      changes.map((change) => {
        const field = context.fields.find((candidate) => candidate.id === change.fieldId);
        return field?.unit && typeof change.to === "number"
          ? { ...change, to: `${change.to}${field.unit}` }
          : change;
      }),
    [changes, context.fields],
  );
  const hasInvalidValue = changes.some((change) => {
    const field = context.fields.find((candidate) => candidate.id === change.fieldId);
    return field ? !isBrowserElementFieldValueValid(field, change.to) : false;
  });
  const handleSubmit = useCallback(
    () => onSubmit({ comment: comment.trim(), changes }),
    [changes, comment, onSubmit],
  );
  const changeFieldValue = useCallback((fieldId: string, value: BrowserElementJson) => {
    dispatch({ type: "field-changed", fieldId, value });
  }, []);
  const resetChanges = useCallback(() => {
    dispatch({ type: "changes-reset", values: initialFieldValues(context.fields) });
  }, [context.fields]);
  const changeComment = useCallback(
    (nextComment: string) => dispatch({ type: "comment-changed", comment: nextComment }),
    [],
  );
  const openDetails = useCallback(() => dispatch({ type: "details-opened" }), []);
  const closeDetails = useCallback(() => dispatch({ type: "details-closed" }), []);
  const hasSubmission = comment.trim().length > 0 || changes.length > 0;
  const canSubmit = hasSubmission && !hasInvalidValue;

  useEffect(() => {
    onPreview(previewChanges);
  }, [onPreview, previewChanges]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return;
      if (event.defaultPrevented || dispatchTopWebOverlayKeyDown(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
        event.preventDefault();
        event.stopPropagation();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [canSubmit, handleSubmit, onCancel]);

  if (!detailsOpen) {
    return (
      <View style={[styles.overlay, overlayStyle]} pointerEvents="box-none">
        <View style={[styles.compactPanel, panelStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={adjustLabel}
            onPress={openDetails}
            style={styles.compactIconButton}
          >
            <ThemedSliders size={15} uniProps={mutedIconMapping} />
          </Pressable>
          <ThemedFieldInput
            accessibilityLabel={commentPlaceholder}
            onChangeText={changeComment}
            placeholder={commentPlaceholder}
            style={styles.compactCommentInput}
            uniProps={inputMapping}
            initialValue={comment}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={[styles.compactSubmit, !canSubmit ? styles.compactSubmitDisabled : null]}
          >
            <ThemedCheck size={16} uniProps={selectedIconMapping} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.overlay, overlayStyle]} pointerEvents="box-none">
      <View style={[styles.panel, panelStyle]}>
        <View style={styles.commentBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={adjustLabel}
            onPress={closeDetails}
            style={styles.toolbarButton}
          >
            <ThemedSliders size={15} uniProps={mutedIconMapping} />
          </Pressable>
          <ThemedFieldInput
            accessibilityLabel={commentPlaceholder}
            onChangeText={changeComment}
            placeholder={commentPlaceholder}
            style={styles.expandedCommentInput}
            uniProps={inputMapping}
            initialValue={comment}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            onPress={onCancel}
            style={styles.toolbarButton}
          >
            <ThemedClose size={15} uniProps={mutedIconMapping} />
          </Pressable>
        </View>

        <View style={styles.targetBlock}>
          <View style={styles.targetHeader}>
            <View style={styles.headerText}>
              <Text numberOfLines={1} selectable>
                <Text style={styles.title}>{context.target.label}</Text>
                {elementText.trim() ? (
                  <Text style={styles.elementText}>
                    {`  ${elementText.trim().replace(/\s+/g, " ")}`}
                  </Text>
                ) : null}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={resetLabel}
              disabled={changes.length === 0}
              onPress={resetChanges}
              style={[styles.toolbarButton, changes.length === 0 ? styles.disabledAction : null]}
            >
              <ThemedUndo size={15} uniProps={mutedIconMapping} />
            </Pressable>
          </View>
        </View>

        <ElementContextFields
          groups={groups}
          isGenericContext={context.provider.id === "paseo.dom"}
          onChange={changeFieldValue}
          values={values}
        />

        <View style={styles.actions}>
          <Button variant="ghost" size="xs" onPress={onCancel}>
            {cancelLabel}
          </Button>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={[styles.panelSubmit, !canSubmit ? styles.compactSubmitDisabled : null]}
          >
            <ThemedCheck size={16} uniProps={selectedIconMapping} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const ThemedFieldInput = withUnistyles(TextInput);
const ThemedCheck = withUnistyles(Check);
const ThemedClose = withUnistyles(X);
const ThemedUndo = withUnistyles(Undo2);
const ThemedSliders = withUnistyles(SlidersHorizontal);
const inputMapping = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const selectedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
