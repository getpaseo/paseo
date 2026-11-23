import type { AccessibilityLabels, ResolvedAccessibilityLabels } from './types/AccessibilityLabels';
/**
 * Default strings spoken by VoiceOver / TalkBack when the consumer does not
 * provide an override. See `AccessibilityLabels` for the placeholder syntax
 * and the rationale for the no-plural cardinal form.
 */
export declare const DEFAULT_ACCESSIBILITY_LABELS: ResolvedAccessibilityLabels;
/**
 * Resolves a partial `AccessibilityLabels` against `DEFAULT_ACCESSIBILITY_LABELS`,
 * returning a fully-populated struct that native code can consume without any
 * null checks. Override resolution is shallow per sub-group: if a consumer
 * passes `{ list: { bulletPoint: 'Punkt' } }`, only that one field changes and
 * the other list entries fall back to the defaults.
 */
export declare function resolveAccessibilityLabels(labels: AccessibilityLabels | undefined): ResolvedAccessibilityLabels;
//# sourceMappingURL=accessibilityLabelDefaults.d.ts.map