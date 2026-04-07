import { useState, useEffect, useCallback } from "react";
import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";

export interface PyWalColors {
  background: string;
  foreground: string;
  cursor: string;
  colors: string[];
}

export interface PyWalColorMapping {
  accent: number | "background" | "foreground" | "cursor";
  accentBright: number | "background" | "foreground" | "cursor";
  foreground: number | "background" | "foreground" | "cursor";
  background: number | "background" | "foreground" | "cursor";
  border: number | "background" | "foreground" | "cursor";
  foregroundMuted: number | "background" | "foreground" | "cursor";
  surface0: number | "background" | "foreground" | "cursor";
  surface1: number | "background" | "foreground" | "cursor";
  surface2: number | "background" | "foreground" | "cursor";
  surface3: number | "background" | "foreground" | "cursor";
  surface4: number | "background" | "foreground" | "cursor";
}

export const DEFAULT_PYWAL_MAPPING: PyWalColorMapping = {
  accent: 1,
  accentBright: 2,
  foreground: "foreground",
  background: "background",
  border: 3,
  foregroundMuted: 8,
  surface0: "background",
  surface1: 2,
  surface2: 8,
  surface3: 3,
  surface4: 4,
};

function parsePyWalColorsFromShell(content: string): PyWalColors {
  const lines = content.split("\n");
  const result: PyWalColors = {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffffff",
    colors: Array(16).fill("#000000"),
  };

  for (const line of lines) {
    const match = line.match(/^(\w+)=['"]?([^'"]+)['"]?$/);
    if (!match) continue;

    const [, name, value] = match;
    if (name === "background") result.background = value;
    else if (name === "foreground") result.foreground = value;
    else if (name === "cursor") result.cursor = value;
    else if (name.startsWith("color")) {
      const index = parseInt(name.replace("color", ""), 10);
      if (index >= 0 && index <= 15) {
        result.colors[index] = value;
      }
    }
  }

  return result;
}

function getPyWalCachePath(): string {
  if (Platform.OS === "web") {
    return "wal/colors.sh";
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return `${homeDir}/.cache/wal/colors.sh`;
}

export function usePyWalColors(pollingIntervalMs = 30000) {
  const [colors, setColors] = useState<PyWalColors | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadColors = useCallback(async () => {
    try {
      const shPath = getPyWalCachePath();
      const content = await FileSystem.readAsStringAsync(shPath).catch(() => null);

      if (content) {
        const parsed = parsePyWalColorsFromShell(content);
        setColors(parsed);
        setLastUpdated(new Date());
      }
    } catch (error) {
      console.error("[PyWal] Failed to load colors:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadColors();
    const interval = setInterval(loadColors, pollingIntervalMs);
    return () => clearInterval(interval);
  }, [loadColors, pollingIntervalMs]);

  return { colors, isLoading, lastUpdated, refresh: loadColors };
}