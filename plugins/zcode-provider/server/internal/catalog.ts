/**
 * ZCode's config options, as they arrive on a session snapshot
 * (`packages/shared/src/zcode-task-types-core.ts:392-402` in the ZCode
 * repository). The array is flat; `category` says what each option configures.
 */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** "mode" | "model" | "thought_level", or a custom category. */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: Array<{ value: string; name: string; description?: string }>;
}
