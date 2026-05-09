const USER_INSTRUCTIONS_NOTICE =
  "The instructions below are provided by the project owner and override the guidelines above where they conflict.";

export function wrapWithUserInstructions(
  beforeBlock: string,
  instructions: string | undefined | null,
  afterBlock: string,
): string {
  if (typeof instructions !== "string" || instructions.trim() === "") {
    return `${beforeBlock}\n\n${afterBlock}`;
  }

  return `${beforeBlock}

<user-instructions>
${USER_INSTRUCTIONS_NOTICE}

${instructions}
</user-instructions>

${afterBlock}`;
}
