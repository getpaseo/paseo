const USER_INSTRUCTIONS_NOTICE =
  "The instructions below are provided by the project owner and override the guidelines above where they conflict.";

export function wrapWithUserInstructions(
  beforeBlock: string,
  instructions: string,
  afterBlock: string,
): string {
  return `${beforeBlock}

<user-instructions>
${USER_INSTRUCTIONS_NOTICE}

${instructions}
</user-instructions>

${afterBlock}`;
}
