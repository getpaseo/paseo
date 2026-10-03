import React, { useEffect, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { submissionDecisionStore, type SubmissionDecisionModel } from "./submission-decision";

const snapPoints = ["70%", "90%"];

export function SubmissionDecisionSheet() {
  const model = useSyncExternalStore(
    submissionDecisionStore.subscribe,
    submissionDecisionStore.getSnapshot,
  );
  useEffect(() => () => submissionDecisionStore.cancel(), []);
  return model ? <OpenSubmissionDecision model={model} /> : null;
}

function OpenSubmissionDecision({ model }: { model: SubmissionDecisionModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const { decision } = model;
  const header = useMemo(() => ({ title: decision.title }), [decision.title]);
  const footer = useMemo(() => {
    const choices = decision.choices.map((choice) => ({
      ...choice,
      onPress: () => model.choose(choice.id),
    }));
    return (
      <View style={styles.choices} onTouchStart={model.interact} onPointerDown={model.interact}>
        {choices.map((choice) => (
          <View key={choice.id} style={styles.choice}>
            <Button
              variant={choice.id === decision.timeout?.choiceId ? "default" : "secondary"}
              onPress={choice.onPress}
              accessibilityLabel={choice.title}
              style={styles.button}
            >
              {choice.title}
            </Button>
            {choice.description ? (
              <Text style={styles.description}>{choice.description}</Text>
            ) : null}
          </View>
        ))}
      </View>
    );
  }, [decision, model]);
  const timeoutChoice = decision.choices.find((choice) => choice.id === decision.timeout?.choiceId);
  return (
    <AdaptiveModalSheet
      visible={!state.closed}
      onClose={model.cancel}
      header={header}
      snapPoints={snapPoints}
      footer={footer}
      testID="plugin-submission-decision"
    >
      <View style={styles.content} onTouchStart={model.interact} onPointerDown={model.interact}>
        {decision.description ? (
          <Text style={styles.description}>{decision.description}</Text>
        ) : null}
        {decision.textInput ? (
          <View style={styles.field}>
            <Text style={styles.label}>{decision.textInput.label}</Text>
            <AdaptiveTextInput
              initialValue={state.textValue}
              placeholder={decision.textInput.placeholder}
              onFocus={model.interact}
              onChangeText={model.setText}
              autoFocus={false}
              accessibilityLabel={decision.textInput.label}
              style={styles.input}
            />
          </View>
        ) : null}
        {decision.timeout ? (
          <Text style={styles.hint}>
            {state.timerActive
              ? `${timeoutChoice?.title} in ${state.secondsRemaining}s. Interact to pause.`
              : "Automatic selection paused. Choose when you are ready."}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4], paddingBottom: theme.spacing[4] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  field: { gap: theme.spacing[2] },
  input: {
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  choices: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  choice: { flex: 1, minWidth: 140, gap: theme.spacing[2] },
  button: { width: "100%" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
