import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface ConnectionStatusProps {
  isConnected: boolean;
}

const styles = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.zinc[800],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    marginRight: theme.spacing[2],
  },
  dotConnected: {
    backgroundColor: theme.colors.green[500],
  },
  dotDisconnected: {
    backgroundColor: theme.colors.red[500],
  },
  text: {
    fontSize: theme.fontSize.sm,
  },
  textConnected: {
    color: theme.colors.green[500],
  },
  textDisconnected: {
    color: theme.colors.red[500],
  },
}));

export function ConnectionStatus({ isConnected }: ConnectionStatusProps) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={[styles.dot, isConnected ? styles.dotConnected : styles.dotDisconnected]} />
        <Text style={[styles.text, isConnected ? styles.textConnected : styles.textDisconnected]}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </Text>
      </View>
    </View>
  );
}
