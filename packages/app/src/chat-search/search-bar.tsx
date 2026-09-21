import React, { useCallback } from "react";
import type { useChatSearchController } from "./controller";
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from "react-native";
export function SearchBar({
  controller,
  onClose,
}: {
  controller: ReturnType<typeof useChatSearchController>;
  onClose?: () => void;
}) {
  const { state, performSearch, closeSearch, nextMatch, prevMatch } = controller;
  const handleClose = useCallback(() => {
    closeSearch();
    onClose?.();
  }, [closeSearch, onClose]);
  if (!state.isActive) return null;
  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={state.query}
        onChangeText={performSearch}
        placeholder="Find in chat..."
        autoFocus
      />
      {state.isSearching && <Text>...</Text>}
      {!state.isSearching && state.matches.length > 0 && (
        <Text>
          {state.currentIndex + 1}/{state.matches.length}
        </Text>
      )}
      <TouchableOpacity onPress={prevMatch} style={styles.btn}>
        <Text>Prev</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={nextMatch} style={styles.btn}>
        <Text>Next</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleClose} style={styles.btn}>
        <Text>Close</Text>
      </TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", padding: 8, backgroundColor: "#eee" },
  input: {
    flex: 1,
    height: 32,
    backgroundColor: "#fff",
    paddingHorizontal: 8,
    marginRight: 8,
    borderRadius: 4,
  },
  btn: { padding: 8 },
});
