// Opens every collapsed example around an element, outermost first, so a link
// into a nested block lands somewhere visible.
export function openEnclosingExamples(target: Element): void {
  let details = target.closest("details");
  while (details) {
    details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
}
