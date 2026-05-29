export function shouldAutofocusModelSearch(input: { isWeb: boolean; isCompact: boolean }): boolean {
  return input.isWeb && !input.isCompact;
}
