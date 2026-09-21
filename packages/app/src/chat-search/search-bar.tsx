
import React from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
export function SearchBar({ controller, onClose }: { controller: any, onClose?: () => void }) {
  const { state, performSearch, closeSearch, nextMatch, prevMatch } = controller;
  const handleClose = () => { closeSearch(); onClose?.(); };
  if (!state.isActive) return null;
  return (
    <View style={styles.container}>
      <TextInput style={styles.input} value={state.query} onChangeText={performSearch} placeholder="Find in chat..." autoFocus />
      {state.isSearching && <Text>...</Text>}
      {!state.isSearching && state.matches.length > 0 && <Text>{state.currentIndex + 1}/{state.matches.length}</Text>}
      <TouchableOpacity onPress={prevMatch} style={styles.btn}><Text>Prev</Text></TouchableOpacity>
      <TouchableOpacity onPress={nextMatch} style={styles.btn}><Text>Next</Text></TouchableOpacity>
      <TouchableOpacity onPress={handleClose} style={styles.btn}><Text>Close</Text></TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: '#eee' }, input: { flex: 1, height: 32, backgroundColor: '#fff', paddingHorizontal: 8, marginRight: 8, borderRadius: 4 }, btn: { padding: 8 } });
