/** A Vitest asymmetric matcher for one provider turn id. */
export interface TurnIdMatcher {
  asymmetricMatch(actual: unknown): boolean;
  toString(): string;
  toAsymmetricMatcher(): string;
}

/**
 * Matches the turn ids one provider session issues. Each session mixes a random nonce into its
 * ids, so the first id seen binds that nonce and every later match must be the exact id
 * `<owner>-turn-<nonce>-<ordinal>`. Two events of one turn therefore match only when their ids
 * are identical. Create one per test.
 */
export function sessionTurnIds(owner: string): (ordinal: number) => TurnIdMatcher {
  let nonce: string | null = null;
  const pattern = new RegExp(`^${owner}-turn-([0-9a-f]+)-(\\d+)$`);
  return (ordinal) => {
    const describe = () => `${owner}-turn-${nonce ?? "<nonce>"}-${ordinal}`;
    return {
      asymmetricMatch(actual) {
        const match = typeof actual === "string" ? pattern.exec(actual) : null;
        if (!match || Number(match[2]) !== ordinal) return false;
        nonce ??= match[1]!;
        return match[1] === nonce;
      },
      toString: describe,
      toAsymmetricMatcher: describe,
    };
  };
}
