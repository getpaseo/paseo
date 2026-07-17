const testTheme = {
  colorScheme: "light",
  colors: {
    foreground: "#111111",
    foregroundMuted: "#666666",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
  },
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontSize: {
    xs: 12,
    sm: 14,
  },
  fontWeight: {
    normal: "400",
    medium: "500",
  },
  borderRadius: {
    base: 4,
    md: 6,
  },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    isStyleFactory(styles) ? styles(testTheme) : styles,
};

export const withUnistyles = <T>(Component: T): T => Component;

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
