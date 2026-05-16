// Adapted from type-fest's LiteralUnion:
// https://github.com/sindresorhus/type-fest/blob/main/source/literal-union.d.ts
export type LiteralUnion<T extends U, U extends string> = T | (U & Record<never, never>);
