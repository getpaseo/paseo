import type { Assessment, ProjectDecision } from "./contracts";
import type { IntakePreferences } from "./preferences";

export function isGreeting(text: string): boolean {
  return /^(hi|hey|hello|hallo|moin|servus|guten tag|danke|thanks)[.!?\s]*$/i.test(text.trim());
}

export function projectName(text: string): string {
  const match =
    text.match(/\b(?:called|named|namens|heißt)\s+([\p{L}\p{N}][\p{L}\p{N}-]{1,35})\b/iu) ??
    text.match(
      /\b(?:build|create|develop|implement|baue|entwickle|erstelle)\s+(?:(?:a|an|the|ein|eine|das|new|neues|neue)\s+)*([\p{L}\p{N}][\p{L}\p{N}-]{1,35})\s+(?:product|app|platform|produkt|anwendung)\b/iu,
    ) ??
    text.match(/\b([A-Z][\p{L}\p{N}-]{1,35})\s+(?:product|app|platform|produkt|anwendung)\b/u);
  const candidate = match?.[1];
  if (!candidate || /^(New|Software|Feature|Fix|The|Ein|Eine|Das)$/i.test(candidate))
    return "new-product";
  const normalized =
    candidate
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "new-product";
  try {
    return validateProjectName(normalized);
  } catch {
    return "new-product";
  }
}

export function validateProjectName(value: string): string {
  const name = value.trim();
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
  )
    throw new Error("Use a short project name with letters, numbers, hyphens or underscores.");
  return name;
}

export function assessPolicy(input: {
  text: string;
  currentName: string;
  parentPath: string;
  preferences: IntakePreferences;
  decision?: ProjectDecision;
  unavailableReason?: string;
}): Assessment {
  const { preferences: settings, decision } = input;
  const confident = decision && decision.confidence >= settings.minimumConfidence;
  const recommendation = confident && decision.choice === "new" ? "new" : "current";
  const proposedName = projectName(input.text);
  const explicitNewProduct =
    /\b(?:new (?:product|app|platform)|neue[nsr]? (?:produkt|app|anwendung)|eigen(?:es|e|en) (?:produkt|projekt))\b/i.test(
      input.text,
    );
  const showDecision =
    settings.enabled &&
    !isGreeting(input.text) &&
    input.text.trim().length > 5 &&
    (!confident || decision.choice !== "current" || explicitNewProduct);
  let explanation = `Project fit could not be confirmed${input.unavailableReason ? `: ${input.unavailableReason}` : ""}. The current project stays selected unless you choose otherwise.`;
  if (decision) {
    explanation = `Project fit is unclear. Keep ${input.currentName} or choose a separate project.`;
    if (recommendation === "new")
      explanation = `System One recommends a separate project after comparing your request with ${input.currentName}.`;
    else if (confident && decision.choice === "current")
      explanation = `System One finds this request fits ${input.currentName}.`;
  }
  return {
    showDecision,
    currentName: input.currentName,
    proposedName,
    parentPath: input.parentPath,
    recommendation,
    explanation,
    source: decision ? "jev" : "local",
    ...(decision ? { confidence: decision.confidence } : {}),
    ...(showDecision && settings.unansweredAction !== "wait"
      ? {
          timeout: {
            seconds: settings.waitSeconds,
            choiceId:
              settings.unansweredAction === "current" || proposedName === "new-product"
                ? ("current" as const)
                : recommendation,
          },
        }
      : {}),
  };
}
