import { StyleSheet } from "react-native-unistyles";

export const chatStyles = StyleSheet.create((theme) => ({
  rail: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: 26, xl: 37 },
  },
}));
