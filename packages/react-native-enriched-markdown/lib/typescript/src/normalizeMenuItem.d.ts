export type NormalizedMenuItem = {
    enabled: boolean;
    label: string;
};
export declare const normalizeMenuItem: (raw: unknown, defaultEnabled: boolean, defaultLabel: string) => NormalizedMenuItem;
export declare const normalizeLegacyBooleanMenuItem: (raw: unknown, parentProp: string, field: string, defaultEnabled: boolean, defaultLabel: string) => NormalizedMenuItem;
//# sourceMappingURL=normalizeMenuItem.d.ts.map