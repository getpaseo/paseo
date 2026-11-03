import type { KeyboardInputEvent } from "@/keyboard";
export function navigateMenuKeyboard(event: KeyboardInputEvent): boolean {
  const target = document.activeElement;
  const surface = target?.closest<HTMLElement>('[data-menu-surface="true"]');
  if (!surface) return false;
  const items = Array.from(
    surface.querySelectorAll<HTMLElement>(
      '[data-menu-item="true"]:not([data-menu-disabled="true"])',
    ),
  );
  if (items.length === 0) return false;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown")
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  if (event.key === "ArrowUp")
    nextIndex =
      currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = items.length - 1;
  if (nextIndex !== null) {
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
    return true;
  }
  if ((event.key === "Enter" || event.key === " ") && currentIndex >= 0) {
    event.preventDefault();
    event.stopPropagation();
    items[currentIndex]?.click();
    return true;
  }
  return false;
}
