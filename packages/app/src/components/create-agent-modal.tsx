import { useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { theme as defaultTheme } from "@/styles/theme";

interface CreateAgentModalProps {
  isVisible: boolean;
  onClose: () => void;
  onCreateAgent: (workingDir: string, mode: string) => void;
}

const MODES = [
  {
    value: "plan",
    label: "Plan",
    description: "Plan and design before implementing",
  },
  {
    value: "bypassPermissions",
    label: "Bypass Permissions",
    description: "Skip permission prompts for faster execution",
  },
] as const;

export function CreateAgentModal({
  isVisible,
  onClose,
  onCreateAgent,
}: CreateAgentModalProps) {
  const [workingDir, setWorkingDir] = useState("");
  const [selectedMode, setSelectedMode] = useState("plan");
  const [errorMessage, setErrorMessage] = useState("");

  function handleCreate() {
    if (!workingDir.trim()) {
      setErrorMessage("Working directory is required");
      return;
    }

    onCreateAgent(workingDir.trim(), selectedMode);
    handleClose();
  }

  function handleClose() {
    setWorkingDir("");
    setSelectedMode("plan");
    setErrorMessage("");
    onClose();
  }

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      transparent={true}
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={styles.modalBackdrop} onPress={handleClose} />
        <View style={styles.modalContent}>
          <View style={styles.modalInner}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.headerTitle}>Create New Agent</Text>
              <Pressable onPress={handleClose}>
                <X size={24} color="white" />
              </Pressable>
            </View>

            {/* Form */}
            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              {/* Working Directory Input */}
              <View style={styles.formSection}>
                <Text style={styles.label}>Working Directory</Text>
                <TextInput
                  style={styles.input}
                  placeholder="/path/to/project"
                  placeholderTextColor={defaultTheme.colors.mutedForeground}
                  value={workingDir}
                  onChangeText={(text) => {
                    setWorkingDir(text);
                    setErrorMessage("");
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {errorMessage ? (
                  <Text style={styles.errorText}>{errorMessage}</Text>
                ) : (
                  <Text style={styles.helperText}>
                    Absolute path to the project directory
                  </Text>
                )}
              </View>

              {/* Mode Selector */}
              <View style={styles.formSection}>
                <Text style={styles.label}>Mode</Text>
                <View style={styles.modeContainer}>
                  {MODES.map((mode) => (
                    <Pressable
                      key={mode.value}
                      onPress={() => setSelectedMode(mode.value)}
                      style={[
                        styles.modeOption,
                        selectedMode === mode.value &&
                          styles.modeOptionSelected,
                      ]}
                    >
                      <View style={styles.modeOptionContent}>
                        <View
                          style={[
                            styles.radioOuter,
                            selectedMode === mode.value
                              ? styles.radioOuterSelected
                              : styles.radioOuterUnselected,
                          ]}
                        >
                          {selectedMode === mode.value && (
                            <View style={styles.radioInner} />
                          )}
                        </View>
                        <View style={styles.modeTextContainer}>
                          <Text style={styles.modeLabel}>{mode.label}</Text>
                          <Text style={styles.modeDescription}>
                            {mode.description}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Action Buttons */}
              <View style={styles.buttonContainer}>
                <Pressable
                  style={[styles.createButton, !workingDir.trim() && styles.createButtonDisabled]}
                  onPress={handleCreate}
                  disabled={!workingDir.trim()}
                >
                  <Text style={styles.createButtonText}>Create Agent</Text>
                </Pressable>

                <Pressable style={styles.cancelButton} onPress={handleClose}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalBackdrop: {
    flex: 1,
  },
  modalContent: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.spacing[6],
    borderTopRightRadius: theme.spacing[6],
    height: "75%",
  },
  modalInner: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[6],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[6],
    paddingBottom: theme.spacing[4] * 5,
  },
  formSection: {
    marginBottom: theme.spacing[6],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.background,
    color: theme.colors.foreground,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  helperText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  modeContainer: {
    gap: theme.spacing[3],
  },
  modeOption: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
  },
  modeOptionSelected: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  modeOptionContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: theme.colors.palette.blue[500],
  },
  radioOuterUnselected: {
    borderColor: theme.colors.border,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  modeTextContainer: {
    flex: 1,
  },
  modeLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  modeDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  buttonContainer: {
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
  createButton: {
    backgroundColor: theme.colors.palette.blue[500],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
  },
  createButtonDisabled: {
    backgroundColor: theme.colors.palette.blue[900],
    opacity: theme.opacity[50],
  },
  createButtonText: {
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  cancelButton: {
    backgroundColor: "transparent",
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  cancelButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
}));
