import { useState, useCallback } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, X, Send } from "lucide-react-native";
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

export function QuestionFormCard({
  permission,
  onRespond,
  isResponding,
}: QuestionFormCardProps) {
  const { theme } = useUnistyles();
  const questions = parseQuestions(permission.request.input);

  // selections[questionIndex] = Set of selected option indices
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  // otherTexts[questionIndex] = custom "Other" text
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

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
      // Clear "Other" text when an option is selected
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
    // Clear option selections when typing "Other"
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
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {questions.map((q, qIndex) => {
        const selected = selections[qIndex] ?? new Set<number>();
        const otherText = otherTexts[qIndex] ?? "";

        return (
          <View key={qIndex} style={styles.questionBlock}>
            <Text
              style={[styles.header, { color: theme.colors.foregroundMuted }]}
            >
              {q.header}
            </Text>
            <Text
              style={[styles.questionText, { color: theme.colors.foreground }]}
            >
              {q.question}
            </Text>
            <View style={styles.optionsWrap}>
              {q.options.map((opt, optIndex) => {
                const isSelected = selected.has(optIndex);
                return (
                  <Pressable
                    key={optIndex}
                    style={(state) => {
                      const hovered = Boolean((state as any).hovered);
                      return [
                        styles.chip,
                        {
                          borderColor: isSelected
                            ? theme.colors.accent
                            : theme.colors.border,
                          backgroundColor: isSelected
                            ? `${theme.colors.accent}18`
                            : hovered
                              ? theme.colors.surface1
                              : theme.colors.surface2,
                        },
                      ];
                    }}
                    onPress={() => toggleOption(qIndex, optIndex, q.multiSelect)}
                    disabled={isResponding}
                  >
                    <View style={styles.chipContent}>
                      {q.multiSelect && isSelected ? (
                        <Check size={14} color={theme.colors.accent} />
                      ) : null}
                      <Text
                        style={[
                          styles.chipLabel,
                          {
                            color: isSelected
                              ? theme.colors.accent
                              : theme.colors.foreground,
                          },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </View>
                    {opt.description ? (
                      <Text
                        style={[
                          styles.chipDescription,
                          { color: theme.colors.foregroundMuted },
                        ]}
                      >
                        {opt.description}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              style={[
                styles.otherInput,
                {
                  borderColor: otherText.length > 0
                    ? theme.colors.accent
                    : theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface0,
                },
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

      <View style={styles.actions}>
        <Pressable
          style={(state) => {
            const hovered = Boolean((state as any).hovered);
            return [
              styles.actionButton,
              {
                backgroundColor: hovered
                  ? theme.colors.surface1
                  : theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ];
          }}
          onPress={handleDeny}
          disabled={isResponding}
        >
          {isResponding ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
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
          style={(state) => {
            const hovered = Boolean((state as any).hovered);
            const disabled = !allAnswered || isResponding;
            return [
              styles.actionButton,
              {
                backgroundColor: hovered && !disabled
                  ? theme.colors.surface1
                  : theme.colors.surface2,
                borderColor: disabled
                  ? theme.colors.border
                  : theme.colors.accent,
                opacity: disabled ? 0.5 : 1,
              },
            ];
          }}
          onPress={handleSubmit}
          disabled={!allAnswered || isResponding}
        >
          {isResponding ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <View style={styles.actionContent}>
              <Send size={14} color={allAnswered ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text
                style={[
                  styles.actionText,
                  { color: allAnswered ? theme.colors.accent : theme.colors.foregroundMuted },
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
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[3],
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  header: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  questionText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  optionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chip: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    gap: theme.spacing[1],
  },
  chipContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  chipDescription: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  otherInput: {
    borderWidth: theme.borderWidth[1],
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  actionButton: {
    flex: 1,
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
    fontWeight: theme.fontWeight.normal,
  },
}));
