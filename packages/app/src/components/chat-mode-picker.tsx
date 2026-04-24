import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Check, X } from "lucide-react-native";

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { CHAT_MODES, type ChatMode } from "@/components/chat-modes";
import { settingsStyles } from "@/styles/settings";

export interface ChatModePickerProps {
  visible: boolean;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (mode: ChatMode | null) => void;
}

/**
 * Modal for picking (or clearing) the active chat "expert mode".
 * Compact list with emoji + name + description. Search filters against
 * name, description and tags.
 */
export function ChatModePicker({ visible, selectedId, onClose, onSelect }: ChatModePickerProps) {
  const { theme } = useUnistyles();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return CHAT_MODES;
    const q = search.toLowerCase();
    return CHAT_MODES.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [search]);

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title="Pick a chat mode">
      <View style={{ padding: 16, gap: 10 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search modes…"
          placeholderTextColor={theme.colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={{
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />

        <Text style={settingsStyles.rowHint}>
          Optional — a mode prepends a short specialist prompt so the agent answers from that
          perspective. Leave none selected for the default behavior.
        </Text>

        {selectedId ? (
          <Pressable
            onPress={() => onSelect(null)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <X size={14} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Clear current mode</Text>
          </Pressable>
        ) : null}

        <ScrollView
          style={{
            maxHeight: 420,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
          contentContainerStyle={{ paddingVertical: 4 }}
        >
          {filtered.length === 0 ? (
            <Text style={[settingsStyles.rowHint, { padding: 12 }]}>
              No mode matches "{search}".
            </Text>
          ) : (
            filtered.map((m) => {
              const isSelected = m.id === selectedId;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => onSelect(m)}
                  style={({ hovered, pressed }) => [
                    {
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      flexDirection: "row",
                      alignItems: "flex-start",
                      gap: 10,
                      backgroundColor:
                        pressed || hovered || isSelected ? theme.colors.surface2 : "transparent",
                    },
                  ]}
                >
                  <Text style={{ fontSize: 20 }}>{m.emoji}</Text>
                  <View style={{ flex: 1, gap: 4 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 13,
                          fontWeight: "600",
                        }}
                      >
                        {m.name}
                      </Text>
                      <View
                        style={{
                          backgroundColor: theme.colors.surface2,
                          paddingHorizontal: 5,
                          paddingVertical: 1,
                          borderRadius: 3,
                        }}
                      >
                        <Text style={{ fontSize: 9, color: theme.colors.mutedForeground }}>
                          {m.rules.length} rule{m.rules.length === 1 ? "" : "s"} ·{" "}
                          {m.suggestedSkills.length} skill
                          {m.suggestedSkills.length === 1 ? "" : "s"}
                        </Text>
                      </View>
                      {(m.tags ?? []).slice(0, 3).map((tag) => (
                        <View
                          key={tag}
                          style={{
                            backgroundColor: theme.colors.surface2,
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                            borderRadius: 3,
                          }}
                        >
                          <Text style={{ fontSize: 9, color: theme.colors.mutedForeground }}>
                            {tag}
                          </Text>
                        </View>
                      ))}
                    </View>
                    <Text
                      style={{ color: theme.colors.mutedForeground, fontSize: 12 }}
                      numberOfLines={2}
                    >
                      {m.description}
                    </Text>
                    {isSelected ? (
                      <View style={{ gap: 4, marginTop: 4 }}>
                        <Text
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 10,
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                          }}
                        >
                          Rules applied
                        </Text>
                        {m.rules.slice(0, 5).map((r, idx) => (
                          <Text
                            key={idx}
                            style={{
                              color: theme.colors.mutedForeground,
                              fontSize: 11,
                              lineHeight: 15,
                            }}
                          >
                            · {r}
                          </Text>
                        ))}
                        {m.suggestedSkills.length > 0 ? (
                          <>
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 10,
                                fontWeight: "600",
                                textTransform: "uppercase",
                                letterSpacing: 0.5,
                                marginTop: 4,
                              }}
                            >
                              Suggested skills
                            </Text>
                            {m.suggestedSkills.map((s) => (
                              <Text
                                key={s.name}
                                style={{
                                  color: theme.colors.mutedForeground,
                                  fontSize: 11,
                                  lineHeight: 15,
                                }}
                              >
                                · {s.name} ({s.source}) — {s.description}
                              </Text>
                            ))}
                          </>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  {isSelected ? <Check size={14} color={theme.colors.primary} /> : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </View>
    </AdaptiveModalSheet>
  );
}
