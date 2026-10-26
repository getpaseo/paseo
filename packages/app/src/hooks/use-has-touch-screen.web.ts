import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";

function hasTouchScreen(): boolean {
  return isWeb && typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}

function subscribe(onChange: () => void): () => void {
  if (!isWeb || typeof window === "undefined") return () => {};
  const query = window.matchMedia("(any-pointer: coarse)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getServerSnapshot(): boolean {
  return false;
}

export function useHasTouchScreen(): boolean {
  return useSyncExternalStore(subscribe, hasTouchScreen, getServerSnapshot);
}
