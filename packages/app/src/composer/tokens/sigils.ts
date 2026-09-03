/**
 * Composer trigger sigils.
 *
 * Two menus are triggered from the composer: the command menu (full slash-command
 * list, at line start) and the skill menu (skills only, anywhere in the message).
 * Which character opens each is user-configurable; the pair must stay distinct so
 * a single keystroke never means two things.
 *
 * The choices are an allowlist rather than free text: a sigil that collides with
 * ordinary prose (a letter, a digit, a quote) would open the menu constantly, and
 * `@` is reserved for file mentions.
 */

export const COMPOSER_SIGIL_CHOICES = ["/", "$", "!", "#", ">", "%"] as const;

export type ComposerSigil = (typeof COMPOSER_SIGIL_CHOICES)[number];

export const DEFAULT_COMMAND_SIGIL: ComposerSigil = "/";
export const DEFAULT_SKILL_SIGIL: ComposerSigil = "$";

/** Reserved for file mentions; never selectable as a command or skill sigil. */
export const MENTION_SIGIL = "@";

export interface ComposerSigils {
  command: ComposerSigil;
  skill: ComposerSigil;
}

export const DEFAULT_COMPOSER_SIGILS: ComposerSigils = {
  command: DEFAULT_COMMAND_SIGIL,
  skill: DEFAULT_SKILL_SIGIL,
};

export function isComposerSigil(value: unknown): value is ComposerSigil {
  return typeof value === "string" && (COMPOSER_SIGIL_CHOICES as readonly string[]).includes(value);
}

export function parseComposerSigil(value: unknown): ComposerSigil | null {
  return isComposerSigil(value) ? value : null;
}

function firstSigilExcluding(...taken: readonly string[]): ComposerSigil {
  const available = COMPOSER_SIGIL_CHOICES.find((choice) => !taken.includes(choice));
  // COMPOSER_SIGIL_CHOICES is longer than the number of slots, so this always resolves.
  return available ?? DEFAULT_COMMAND_SIGIL;
}

/**
 * Coerce stored/partial sigil settings into a valid, collision-free pair.
 *
 * Invalid values fall back to their default. If the two would collide, the
 * command sigil wins and the skill sigil moves to the first free choice — the
 * command menu is the older, more load-bearing of the two.
 */
export function resolveComposerSigils(input: {
  command?: unknown;
  skill?: unknown;
}): ComposerSigils {
  const command = parseComposerSigil(input.command) ?? DEFAULT_COMMAND_SIGIL;
  const requestedSkill = parseComposerSigil(input.skill) ?? DEFAULT_SKILL_SIGIL;
  const skill = requestedSkill === command ? firstSigilExcluding(command) : requestedSkill;
  return { command, skill };
}
