import emojiKeywords from "emojilib";

export interface ProjectEmojiIcon {
  emoji: string;
  label: string;
  searchText: string;
}

const DEFAULT_RESULT_LIMIT = 120;
const SEARCH_RESULT_LIMIT = 180;

const POPULAR_EMOJI_CODE_POINTS = [
  0x1f4bc, 0x1f4b0, 0x1f4b2, 0x1f4b5, 0x1fa99, 0x1f4b3, 0x1f3e6, 0x1f4c8, 0x1f4c9, 0x1f680, 0x1f4bb,
  0x1f916, 0x1f9e0, 0x1f4a1, 0x2699, 0x1f6e0, 0x1f527, 0x1f4e6, 0x1f310, 0x1f3e0, 0x1f3e2, 0x1f3ed,
  0x1f3ea, 0x1f4f1, 0x26a1, 0x1f525, 0x2b50, 0x2705, 0x26a0, 0x1f512, 0x1f511, 0x1f6e1, 0x1f41b,
  0x1f9ea, 0x1f52c, 0x1f9ec, 0x1f3a8, 0x1f4f7, 0x1f3ac, 0x1f3b5, 0x1f4d6, 0x1f4d3, 0x1f4c5, 0x1f4cc,
  0x1f4cd, 0x1f30e, 0x1f333, 0x1f331, 0x1f4a7, 0x2600, 0x1f319, 0x2764, 0x1f91d, 0x1f465, 0x1f3af,
  0x1f3c6, 0x1f48e, 0x1f514, 0x1f4e3, 0x1f50d, 0x1f5c2,
];

const EXTRA_ALIASES = new Map<string, readonly string[]>([
  [String.fromCodePoint(0x1f4b0), ["finance", "budget"]],
  [String.fromCodePoint(0x1f4b2), ["finance", "price"]],
  [String.fromCodePoint(0x1f4b5), ["finance", "revenue"]],
  [String.fromCodePoint(0x1fa99), ["finance", "crypto"]],
  [String.fromCodePoint(0x1f4b3), ["finance", "billing"]],
  [String.fromCodePoint(0x1f3e6), ["finance", "accounting"]],
  [String.fromCodePoint(0x1f4c8), ["finance", "analytics"]],
  [String.fromCodePoint(0x1f4c9), ["finance", "analytics"]],
]);

const ALL_PROJECT_EMOJIS: readonly ProjectEmojiIcon[] = Object.entries(emojiKeywords).map(
  ([emoji, keywords]) => {
    const aliases = EXTRA_ALIASES.get(emoji) ?? [];
    const label = (keywords[0] ?? "emoji").replaceAll("_", " ");
    return {
      emoji,
      label,
      searchText: [...keywords, ...aliases].join(" ").toLocaleLowerCase(),
    };
  },
);

const EMOJI_BY_VALUE = new Map(ALL_PROJECT_EMOJIS.map((entry) => [entry.emoji, entry]));

const DEFAULT_PROJECT_EMOJIS = POPULAR_EMOJI_CODE_POINTS.map((codePoint) =>
  EMOJI_BY_VALUE.get(String.fromCodePoint(codePoint)),
).filter((entry): entry is ProjectEmojiIcon => entry !== undefined);

function normalizeQuery(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function searchProjectEmojiIcons(query: string): readonly ProjectEmojiIcon[] {
  const terms = normalizeQuery(query);
  if (terms.length === 0) {
    return DEFAULT_PROJECT_EMOJIS.slice(0, DEFAULT_RESULT_LIMIT);
  }

  return ALL_PROJECT_EMOJIS.filter((entry) =>
    terms.every((term) => entry.searchText.includes(term)),
  ).slice(0, SEARCH_RESULT_LIMIT);
}
