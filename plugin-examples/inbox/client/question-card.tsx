import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { buildAnswers, isAnswered, parseQuestions, type Question } from "./question-form";
import type { PermissionRequest, PermissionResponse } from "./types";

interface QuestionCardProps {
  request: PermissionRequest;
  theme: PluginTheme;
  disabled: boolean;
  onRespond(response: PermissionResponse): void;
}

type SelectionMap = Map<number, Set<number>>;
type OtherMap = Map<number, string>;

function useQuestionStyles(theme: PluginTheme) {
  return useMemo(
    () =>
      StyleSheet.create({
        container: { gap: 8 },
        stepper: { color: theme.colors.foregroundMuted, fontSize: 12 },
        question: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
        muted: { color: theme.colors.foregroundMuted },
        input: {
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: 13,
        },
        buttonRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
      }),
    [theme],
  );
}

function OptionRow({
  index,
  label,
  description,
  selected,
  multiSelect,
  disabled,
  theme,
  onToggle,
}: {
  index: number;
  label: string;
  description: string | undefined;
  selected: boolean;
  multiSelect: boolean;
  disabled: boolean;
  theme: PluginTheme;
  onToggle(index: number): void;
}) {
  const handlePress = useCallback(() => onToggle(index), [index, onToggle]);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          borderWidth: 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          gap: 2,
        },
        label: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
        description: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
      }),
    [selected, theme],
  );
  return (
    <Pressable
      accessibilityRole={multiSelect ? "checkbox" : "radio"}
      accessibilityState={accessibilityState}
      onPress={handlePress}
      disabled={disabled}
      style={styles.row}
    >
      <Text style={styles.label}>{label}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </Pressable>
  );
}

interface DerivedState {
  question: Question | null;
  questionCount: number;
  selected: Set<number> | undefined;
  other: string | undefined;
  answered: boolean;
  isLast: boolean;
  allAnswered: boolean;
}

function deriveState(
  questions: Question[] | null,
  active: number,
  selections: SelectionMap,
  others: OtherMap,
): DerivedState {
  const questionCount = questions?.length ?? 0;
  const question = questions ? questions[Math.min(active, questions.length - 1)] : null;
  const selected = selections.get(active);
  const other = others.get(active);
  return {
    question,
    questionCount,
    selected,
    other,
    answered: question ? isAnswered(question, selected, other) : false,
    isLast: active === questionCount - 1,
    allAnswered:
      questions?.every((item, index) =>
        isAnswered(item, selections.get(index), others.get(index)),
      ) ?? false,
  };
}

export function QuestionControls({ request, theme, disabled, onRespond }: QuestionCardProps) {
  const styles = useQuestionStyles(theme);
  const questions = useMemo(() => parseQuestions(request.input), [request.input]);
  const [active, setActive] = useState(0);
  const [selections, setSelections] = useState<SelectionMap>(() => new Map());
  const [others, setOthers] = useState<OtherMap>(() => new Map());

  const submit = useCallback(
    (nextSelections: SelectionMap, nextOthers: OtherMap) => {
      if (!questions) return;
      const input = typeof request.input === "object" && request.input ? request.input : {};
      onRespond({
        behavior: "allow",
        updatedInput: { ...input, answers: buildAnswers(questions, nextSelections, nextOthers) },
      });
    },
    [onRespond, questions, request.input],
  );

  const { question, questionCount, selected, other, answered, isLast, allAnswered } = deriveState(
    questions,
    active,
    selections,
    others,
  );

  const toggle = useCallback(
    (optionIndex: number) => {
      if (disabled || !question) return;
      const next = new Map(selections);
      const current = new Set(question.multiSelect ? (selected ?? []) : []);
      if (current.has(optionIndex)) current.delete(optionIndex);
      else current.add(optionIndex);
      next.set(active, current);
      setSelections(next);
      // A single question with one pick answers immediately.
      if (!question.multiSelect && questionCount === 1) submit(next, others);
    },
    [active, disabled, others, question, questionCount, selected, selections, submit],
  );

  const advance = useCallback(() => {
    if (!answered || disabled) return;
    if (isLast) submit(selections, others);
    else setActive(active + 1);
  }, [active, answered, disabled, isLast, others, selections, submit]);

  const back = useCallback(() => setActive((value) => Math.max(0, value - 1)), []);

  const changeOther = useCallback(
    (text: string) => {
      const next = new Map(others);
      next.set(active, text);
      setOthers(next);
    },
    [active, others],
  );

  if (!questions || !question) {
    return <Text style={styles.muted}>{request.title ?? request.name}</Text>;
  }

  const showsButtons = questionCount > 1 || question.multiSelect || question.options.length === 0;

  return (
    <View style={styles.container}>
      {questionCount > 1 ? (
        <Text style={styles.stepper}>
          {active + 1} of {questionCount} · {question.header}
        </Text>
      ) : null}
      <Text style={styles.question}>{question.question}</Text>
      {question.options.map((option, optionIndex) => (
        <OptionRow
          key={option.label}
          index={optionIndex}
          label={option.label}
          description={option.description}
          selected={selected?.has(optionIndex) ?? false}
          multiSelect={question.multiSelect}
          disabled={disabled}
          theme={theme}
          onToggle={toggle}
        />
      ))}
      {question.allowOther ? (
        <TextInput
          value={other ?? ""}
          editable={!disabled}
          placeholder={question.options.length === 0 ? "Your answer" : "Other…"}
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={changeOther}
          onSubmitEditing={advance}
          style={styles.input}
        />
      ) : null}
      {showsButtons ? (
        <View style={styles.buttonRow}>
          {active > 0 ? <ActionButton theme={theme} label="Back" onPress={back} /> : null}
          <ActionButton
            theme={theme}
            primary
            disabled={disabled || (isLast ? !allAnswered : !answered)}
            label={isLast ? "Submit" : "Next"}
            onPress={advance}
          />
        </View>
      ) : null}
    </View>
  );
}

function buttonColor(theme: PluginTheme, primary: boolean, danger: boolean): string {
  if (primary) return theme.colors.accentForeground;
  if (danger) return theme.colors.statusDanger;
  return theme.colors.foreground;
}

export function ActionButton({
  theme,
  label,
  onPress,
  primary = false,
  danger = false,
  disabled = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        button: {
          backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 7,
          opacity: disabled ? 0.5 : 1,
        },
        label: { color: buttonColor(theme, primary, danger), fontSize: 13, fontWeight: "600" },
      }),
    [danger, disabled, primary, theme],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onPress}
      disabled={disabled}
      style={styles.button}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}
