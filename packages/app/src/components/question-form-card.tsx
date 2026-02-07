import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native";
import { StyleSheet, useUnistyles, UnistylesRuntime } from "react-native-unistyles";
import { Check, CircleHelp, X } from "lucide-react-native";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function parseQuestions(input: unknown): Question[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: Question[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
}

const IS_WEB = Platform.OS === "web";

export function QuestionFormCard({
  permission,
  onRespond,
  isResponding,
}: QuestionFormCardProps) {
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const questions = parseQuestions(permission.request.input);

  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [respondingAction, setRespondingAction] = useState<
    "submit" | "dismiss" | null
  >(null);

  const toggleOption = useCallback(
    (qIndex: number, optIndex: number, multiSelect: boolean) => {
      setSelections((prev) => {
        const current = prev[qIndex] ?? new Set<number>();
        const next = new Set(current);
        if (multiSelect) {
          if (next.has(optIndex)) {
            next.delete(optIndex);
          } else {
            next.add(optIndex);
          }
        } else {
          if (next.has(optIndex)) {
            next.clear();
          } else {
            next.clear();
            next.add(optIndex);
          }
        }
        return { ...prev, [qIndex]: next };
      });
      setOtherTexts((prev) => {
        if (!prev[qIndex]) return prev;
        const next = { ...prev };
        delete next[qIndex];
        return next;
      });
    },
    []
  );

  const setOtherText = useCallback((qIndex: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIndex]: text }));
    if (text.length > 0) {
      setSelections((prev) => {
        if (!prev[qIndex] || prev[qIndex].size === 0) return prev;
        return { ...prev, [qIndex]: new Set<number>() };
      });
    }
  }, []);

  if (!questions) {
    return null;
  }

  const allAnswered = questions.every((_, qIndex) => {
    const selected = selections[qIndex];
    const otherText = otherTexts[qIndex]?.trim();
    return (selected && selected.size > 0) || (otherText && otherText.length > 0);
  });

  function handleSubmit() {
    setRespondingAction("submit");
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions!.length; i++) {
      const q = questions![i];
      const selected = selections[i];
      const otherText = otherTexts[i]?.trim();

      if (otherText && otherText.length > 0) {
        answers[q.header] = otherText;
      } else if (selected && selected.size > 0) {
        const labels = Array.from(selected).map((idx) => q.options[idx].label);
        answers[q.header] = labels.join(", ");
      }
    }

    onRespond({
      behavior: "allow",
      updatedInput: { ...permission.request.input, answers },
    });
  }

  function handleDeny() {
    setRespondingAction("dismiss");
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {questions.map((q, qIndex) => {
        const selected = selections[qIndex] ?? new Set<number>();
        const otherText = otherTexts[qIndex] ?? "";

        return (
          <View key={qIndex} style={styles.questionBlock}>
            <View style={styles.questionHeader}>
              <Text
                style={[styles.questionText, { color: theme.colors.foreground }]}
              >
                {q.question}
              </Text>
              <CircleHelp size={14} color={theme.colors.foregroundMuted} />
            </View>
            <View style={styles.optionsWrap}>
              {q.options.map((opt, optIndex) => {
                const isSelected = selected.has(optIndex);
                return (
                  <Pressable
                    key={optIndex}
                    style={({ pressed, hovered = false }) => [
                      styles.optionItem,
                      (hovered || isSelected) && {
                        backgroundColor: theme.colors.surface2,
                      },
                      pressed && styles.optionItemPressed,
                    ]}
                    onPress={() =>
                      toggleOption(qIndex, optIndex, q.multiSelect)
                    }
                    disabled={isResponding}
                  >
                    <View style={styles.optionItemContent}>
                      <View style={styles.optionTextBlock}>
                        <Text
                          style={[
                            styles.optionLabel,
                            { color: theme.colors.foreground },
                          ]}
                        >
                          {opt.label}
                        </Text>
                        {opt.description ? (
                          <Text
                            style={[
                              styles.optionDescription,
                              { color: theme.colors.foregroundMuted },
                            ]}
                          >
                            {opt.description}
                          </Text>
                        ) : null}
                      </View>
                      {isSelected ? (
                        <View style={styles.optionCheckSlot}>
                          <Check
                            size={16}
                            color={theme.colors.foregroundMuted}
                          />
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              style={[
                styles.otherInput,
                {
                  borderColor: otherText.length > 0
                    ? theme.colors.borderAccent
                    : theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                },
                // @ts-expect-error - outlineStyle is web-only
                IS_WEB && { outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" },
              ]}
              placeholder="Other..."
              placeholderTextColor={theme.colors.foregroundMuted}
              value={otherText}
              onChangeText={(text) => setOtherText(qIndex, text)}
              editable={!isResponding}
            />
          </View>
        );
      })}

      <View
        style={[
          styles.actionsContainer,
          !isMobile && styles.actionsContainerDesktop,
        ]}
      >
        <Pressable
          style={({ pressed, hovered = false }) => [
            styles.actionButton,
            {
              backgroundColor: hovered
                ? theme.colors.surface2
                : theme.colors.surface1,
              borderColor: theme.colors.borderAccent,
            },
            pressed && styles.optionItemPressed,
          ]}
          onPress={handleDeny}
          disabled={isResponding}
        >
          {respondingAction === "dismiss" ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.foregroundMuted}
            />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text
                style={[
                  styles.actionText,
                  { color: theme.colors.foregroundMuted },
                ]}
              >
                Dismiss
              </Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={({ pressed, hovered = false }) => {
            const disabled = !allAnswered || isResponding;
            return [
              styles.actionButton,
              {
                backgroundColor:
                  hovered && !disabled
                    ? theme.colors.surface2
                    : theme.colors.surface1,
                borderColor: disabled
                  ? theme.colors.border
                  : theme.colors.borderAccent,
                opacity: disabled ? 0.5 : 1,
              },
              pressed && !disabled ? styles.optionItemPressed : null,
            ];
          }}
          onPress={handleSubmit}
          disabled={!allAnswered || isResponding}
        >
          {respondingAction === "submit" ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.foreground}
            />
          ) : (
            <View style={styles.actionContent}>
              <Check
                size={14}
                color={
                  allAnswered
                    ? theme.colors.foreground
                    : theme.colors.foregroundMuted
                }
              />
              <Text
                style={[
                  styles.actionText,
                  {
                    color: allAnswered
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted,
                  },
                ]}
              >
                Submit
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[3],
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  questionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  questionText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  optionsWrap: {
    gap: theme.spacing[1],
  },
  optionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  optionItemPressed: {
    opacity: 0.9,
  },
  optionItemContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionTextBlock: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
  },
  optionDescription: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  optionCheckSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
  otherInput: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.sm,
  },
  actionsContainer: {
    gap: theme.spacing[2],
  },
  actionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  actionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionText: {
    fontSize: theme.fontSize.sm,
  },
}));
