import { describe, expect, test } from "vitest";
import { formatAttachmentContentDisposition } from "./content-disposition.js";

describe("formatAttachmentContentDisposition", () => {
  test.each([
    { fileName: "report.txt", disposition: 'attachment; filename="report.txt"' },
    {
      fileName: "café.txt",
      disposition: "attachment; filename=\"caf?.txt\"; filename*=UTF-8''caf%C3%A9.txt",
    },
    {
      fileName: "Résumé Ångström.pdf",
      disposition:
        "attachment; filename=\"R?sum? ?ngstr?m.pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%C3%85ngstr%C3%B6m.pdf",
    },
    {
      fileName: "中文报告 (最终版).txt",
      disposition:
        "attachment; filename=\"???? (???).txt\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%8A%A5%E5%91%8A%20%28%E6%9C%80%E7%BB%88%E7%89%88%29.txt",
    },
    {
      fileName: "report-📄.txt",
      disposition:
        "attachment; filename=\"report-??.txt\"; filename*=UTF-8''report-%F0%9F%93%84.txt",
    },
    {
      fileName: 'say "hi" \\ bye.txt',
      disposition: 'attachment; filename="say \\"hi\\" \\\\ bye.txt"',
    },
    {
      fileName: "100%25 done.txt",
      disposition: "attachment; filename=\"100%25 done.txt\"; filename*=UTF-8''100%2525%20done.txt",
    },
    {
      fileName: "l'été (1)*.txt",
      disposition:
        "attachment; filename=\"l'?t? (1)*.txt\"; filename*=UTF-8''l%27%C3%A9t%C3%A9%20%281%29%2A.txt",
    },
  ])("$fileName", ({ fileName, disposition }) => {
    expect(formatAttachmentContentDisposition(fileName)).toBe(disposition);
  });
});
