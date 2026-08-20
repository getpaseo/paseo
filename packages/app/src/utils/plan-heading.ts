export interface SplitPlanHeading {
  /** The first markdown heading, lifted out for use as a concise title. */
  planHeading?: string;
  /** The plan markdown with the leading heading removed (so it isn't shown twice). */
  bodyText: string;
}

// Plans usually open with a markdown heading (e.g. "# Plan: Calculate 2 + 2"). Lift it
// out as a concise title for the collapsed plan card, and drop it from the body so it
// isn't repeated when the card is expanded. When there's no leading heading, the heading
// is left undefined and the body is returned unchanged.
export function splitPlanHeading(text: string): SplitPlanHeading {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index += 1;
  }
  const headingMatch = lines[index]?.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!headingMatch) {
    return { bodyText: text };
  }
  return {
    planHeading: headingMatch[1].trim(),
    bodyText: lines
      .slice(index + 1)
      .join("\n")
      .trimStart(),
  };
}
