import { readFileSync } from "node:fs";

export function readPublicationWarning(file: string): string | null {
  try {
    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !report ||
      typeof report !== "object" ||
      !("blockers" in report) ||
      !Array.isArray(report.blockers)
    )
      throw new Error("Invalid audit report");
    const count = report.blockers.length;
    if (!count) return null;
    return `Publication bloquée : ${count} ${count === 1 ? "travail à intégrer ou contrôle à résoudre" : "travaux à intégrer ou contrôles à résoudre"}. La version installée est conservée.`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "Publication : rapport de contrôle illisible. Vérifiez le builder local.";
  }
}
