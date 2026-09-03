import { describe, expect, test } from "vitest";
import { validateHeaderValue } from "node:http";
import contentDisposition from "content-disposition";

describe("file download Content-Disposition encoding", () => {
  test("Node rejects raw CJK filenames and accepts RFC 5987 encoding", () => {
    const fileName = "中文报告 (最终版).txt";
    const raw = `attachment; filename="${fileName}"`;

    expect(() => {
      validateHeaderValue("Content-Disposition", raw);
    }).toThrow(/Invalid character in header content/i);

    const encoded = contentDisposition(fileName);
    expect(() => {
      validateHeaderValue("Content-Disposition", encoded);
    }).not.toThrow();
    expect(encoded).toMatch(/^attachment;/i);
    expect(encoded).toMatch(/filename\*=UTF-8''/i);
    const encodedName = encoded.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
    expect(encodedName).toBeTruthy();
    expect(decodeURIComponent(encodedName!)).toBe(fileName);
    for (let i = 0; i < encoded.length; i++) {
      expect(encoded.charCodeAt(i)).toBeLessThan(128);
    }
  });
});
