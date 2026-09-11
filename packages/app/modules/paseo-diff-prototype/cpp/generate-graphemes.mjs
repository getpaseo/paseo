import { writeFileSync } from "node:fs";
import { isExtendingChar } from "@marijn/find-cluster-break";

// Use the installed JS engine's Unicode property data, not a different ICU version.
const ranges = [];
let start = null;
for (let code = 0; code <= 0x110000; code++) {
  const extending = code < 0x110000 && isExtendingChar(code);
  if (extending && start === null) start = code;
  if (!extending && start !== null) {
    ranges.push(`{${start},${code}}`);
    start = null;
  }
}
writeFileSync(
  process.argv[2],
  `#pragma once\n#include <array>\n#include <utility>\ninline constexpr std::array<std::pair<int,int>,${ranges.length}> extendingRanges = {{${ranges.join(",")}}};\n`,
);
