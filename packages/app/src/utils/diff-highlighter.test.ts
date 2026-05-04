import { describe, expect, it } from "vitest";
import {
  parseDiff,
  reconstructNewFile,
  reconstructOldFile,
  highlightDiffFile,
  parseAndHighlightDiff,
  type ParsedDiffFile,
} from "./diff-highlighter";

const SIMPLE_DIFF = `diff --git a/example.ts b/example.ts
index 1234567..abcdefg 100644
--- a/example.ts
+++ b/example.ts
@@ -1,5 +1,5 @@
 const foo = 1;
-const bar = 2;
+const bar = 3;
 const baz = foo + bar;

 export { foo, bar, baz };
`;

const MULTI_HUNK_DIFF = `diff --git a/example.ts b/example.ts
index 1234567..abcdefg 100644
--- a/example.ts
+++ b/example.ts
@@ -1,3 +1,3 @@
 const foo = 1;
-const bar = 2;
+const bar = 3;
 const baz = foo + bar;
@@ -10,3 +10,4 @@
 function greet(name: string) {
   return "Hello, " + name;
 }
+export { greet };
`;

const NEW_FILE_DIFF = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+export { x, y };
`;

const DELETED_FILE_DIFF = `diff --git a/oldfile.ts b/oldfile.ts
deleted file mode 100644
index 1234567..0000000
--- a/oldfile.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const legacy = true;
-export { legacy };
`;

const RUST_DIFF = `diff --git a/lib.rs b/lib.rs
index 1234567..abcdefg 100644
--- a/lib.rs
+++ b/lib.rs
@@ -1,4 +1,4 @@
 fn main() {
-    let version = 1;
+    let version = 2;
     println!("Hello, world!");
 }
`;

const C_DIFF = `diff --git a/example.c b/example.c
index 1234567..abcdefg 100644
--- a/example.c
+++ b/example.c
@@ -1,4 +1,4 @@
 int main(void) {
-    int version = 1;
+    int version = 2;
     return version;
 }
`;

const JAVA_DIFF = `diff --git a/Main.java b/Main.java
index 1234567..abcdefg 100644
--- a/Main.java
+++ b/Main.java
@@ -1,5 +1,5 @@
 public class Main {
     public static void main(String[] args) {
-        int version = 1;
+        int version = 2;
     }
 }
`;

const OBJECTIVE_C_DIFF = `diff --git a/AppDelegate.m b/AppDelegate.m
index 1234567..abcdefg 100644
--- a/AppDelegate.m
+++ b/AppDelegate.m
@@ -1,4 +1,4 @@
 int main(void) {
-    int version = 1;
+    int version = 2;
    return version;
 }
`;

const GO_DIFF = `diff --git a/main.go b/main.go
index 1234567..abcdefg 100644
--- a/main.go
+++ b/main.go
@@ -1,7 +1,7 @@
 package main

 import "fmt"

 func main() {
-    version := 1
+    version := 2
     fmt.Println(version)
 }
`;

const PHP_DIFF = `diff --git a/index.php b/index.php
index 1234567..abcdefg 100644
--- a/index.php
+++ b/index.php
@@ -1,4 +1,4 @@
 <?php
-$version = 1;
+$version = 2;
 echo $version;
 ?>
`;

const YAML_DIFF = `diff --git a/config.yaml b/config.yaml
index 1234567..abcdefg 100644
--- a/config.yaml
+++ b/config.yaml
@@ -1,3 +1,3 @@
 app: paseo
-count: 1
+count: 2
 enabled: true
`;

const XML_DIFF = `diff --git a/config.xml b/config.xml
index 1234567..abcdefg 100644
--- a/config.xml
+++ b/config.xml
@@ -1,3 +1,3 @@
 <config>
-  <count>1</count>
+  <count>2</count>
 </config>
`;

describe("parseDiff", () => {
  it("parses a simple diff with one hunk", () => {
    const files = parseDiff(SIMPLE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("example.ts");
    expect(files[0].isNew).toBe(false);
    expect(files[0].isDeleted).toBe(false);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks).toHaveLength(1);

    const hunk = files[0].hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(5);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(5);

    // Header + 5 content lines (1 context, 1 remove, 1 add, 1 context, 1 blank context, 1 context)
    expect(hunk.lines[0].type).toBe("header");
    expect(hunk.lines[1].type).toBe("context");
    expect(hunk.lines[1].content).toBe("const foo = 1;");
    expect(hunk.lines[2].type).toBe("remove");
    expect(hunk.lines[2].content).toBe("const bar = 2;");
    expect(hunk.lines[3].type).toBe("add");
    expect(hunk.lines[3].content).toBe("const bar = 3;");
  });

  it("parses a diff with multiple hunks", () => {
    const files = parseDiff(MULTI_HUNK_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);

    expect(files[0].hunks[0].oldStart).toBe(1);
    expect(files[0].hunks[0].newStart).toBe(1);

    expect(files[0].hunks[1].oldStart).toBe(10);
    expect(files[0].hunks[1].newStart).toBe(10);
  });

  it("parses a new file diff", () => {
    const files = parseDiff(NEW_FILE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("newfile.ts");
    expect(files[0].isNew).toBe(true);
    expect(files[0].isDeleted).toBe(false);
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  it("parses a deleted file diff", () => {
    const files = parseDiff(DELETED_FILE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("oldfile.ts");
    expect(files[0].isNew).toBe(false);
    expect(files[0].isDeleted).toBe(true);
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(2);
  });

  it("returns empty array for empty input", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("   ")).toEqual([]);
  });
});

describe("reconstructNewFile", () => {
  it("reconstructs the new file version from hunks", () => {
    const files = parseDiff(SIMPLE_DIFF);
    const newFile = reconstructNewFile(files[0].hunks);

    expect(newFile.get(1)).toBe("const foo = 1;");
    expect(newFile.get(2)).toBe("const bar = 3;"); // Changed line
    expect(newFile.get(3)).toBe("const baz = foo + bar;");
    // Note: blank lines in diffs should have a space prefix to be parsed
    // as context lines. In this test the blank line has no prefix so it's
    // not included. That's OK - real git diffs have the space.
    expect(newFile.get(4)).toBe("export { foo, bar, baz };");

    // Old value should not be present
    expect(Array.from(newFile.values())).not.toContain("const bar = 2;");
  });

  it("handles new file (all additions)", () => {
    const files = parseDiff(NEW_FILE_DIFF);
    const newFile = reconstructNewFile(files[0].hunks);

    expect(newFile.get(1)).toBe("const x = 1;");
    expect(newFile.get(2)).toBe("const y = 2;");
    expect(newFile.get(3)).toBe("export { x, y };");
  });
});

describe("reconstructOldFile", () => {
  it("reconstructs the old file version from hunks", () => {
    const files = parseDiff(SIMPLE_DIFF);
    const oldFile = reconstructOldFile(files[0].hunks);

    expect(oldFile.get(1)).toBe("const foo = 1;");
    expect(oldFile.get(2)).toBe("const bar = 2;"); // Original line
    expect(oldFile.get(3)).toBe("const baz = foo + bar;");

    // New value should not be present
    expect(Array.from(oldFile.values())).not.toContain("const bar = 3;");
  });

  it("handles deleted file (all removals)", () => {
    const files = parseDiff(DELETED_FILE_DIFF);
    const oldFile = reconstructOldFile(files[0].hunks);

    expect(oldFile.get(1)).toBe("const legacy = true;");
    expect(oldFile.get(2)).toBe("export { legacy };");
  });
});

describe("highlightDiffFile", () => {
  it("adds syntax highlighting tokens to TypeScript code", () => {
    const files = parseDiff(SIMPLE_DIFF);
    const highlighted = highlightDiffFile(files[0]);

    // Check that tokens are added
    const hunk = highlighted.hunks[0];

    // First content line: "const foo = 1;"
    const constLine = hunk.lines[1];
    expect(constLine.tokens).toContainEqual(
      expect.objectContaining({ text: "const", style: "keyword" }),
    );
    expect(constLine.tokens).toContainEqual(
      expect.objectContaining({ text: "1", style: "number" }),
    );
  });

  it("highlights both added and removed lines correctly", () => {
    const files = parseDiff(SIMPLE_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const hunk = highlighted.hunks[0];

    // Removed line: "const bar = 2;"
    const removedLine = hunk.lines.find((l) => l.type === "remove" && l.content.includes("bar"));
    expect(removedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );

    // Added line: "const bar = 3;"
    const addedLine = hunk.lines.find((l) => l.type === "add" && l.content.includes("bar"));
    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "3", style: "number" }),
    );
  });

  it("does not modify unsupported file types", () => {
    const file: ParsedDiffFile = {
      path: "README.txt",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "header", content: "@@ -1,1 +1,2 @@" },
            { type: "context", content: "Hello" },
            { type: "add", content: "World" },
          ],
        },
      ],
    };

    const highlighted = highlightDiffFile(file);

    // Lines should not have tokens
    expect(highlighted.hunks[0].lines[1].tokens).toBeUndefined();
    expect(highlighted.hunks[0].lines[2].tokens).toBeUndefined();
  });

  it("adds syntax highlighting tokens to Rust code", () => {
    const files = parseDiff(RUST_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const hunk = highlighted.hunks[0];

    expect(hunk.lines[1].tokens).toContainEqual(
      expect.objectContaining({ text: "fn", style: "keyword" }),
    );

    const addedLine = hunk.lines.find(
      (line) => line.type === "add" && line.content.includes("version"),
    );
    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to C code", () => {
    const files = parseDiff(C_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const hunk = highlighted.hunks[0];

    expect(hunk.lines[1].tokens?.length).toBeGreaterThan(0);

    const addedLine = hunk.lines.find(
      (line) => line.type === "add" && line.content.includes("version"),
    );
    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to Java code", () => {
    const files = parseDiff(JAVA_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const hunk = highlighted.hunks[0];

    expect(hunk.lines[1].tokens).toContainEqual(
      expect.objectContaining({ text: "public", style: "keyword" }),
    );

    const addedLine = hunk.lines.find(
      (line) => line.type === "add" && line.content.includes("version"),
    );
    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to Objective-C file extensions", () => {
    const files = parseDiff(OBJECTIVE_C_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const hunk = highlighted.hunks[0];

    const addedLine = hunk.lines.find(
      (line) => line.type === "add" && line.content.includes("version"),
    );
    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to Go code", () => {
    const files = parseDiff(GO_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const addedLine = highlighted.hunks[0].lines.find(
      (line) => line.type === "add" && line.content.includes("version"),
    );

    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to PHP code", () => {
    const files = parseDiff(PHP_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const addedLine = highlighted.hunks[0].lines.find(
      (line) => line.type === "add" && line.content.includes("$version"),
    );

    expect(addedLine?.tokens).toContainEqual(
      expect.objectContaining({ text: "2", style: "number" }),
    );
  });

  it("adds syntax highlighting tokens to YAML code", () => {
    const files = parseDiff(YAML_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const addedLine = highlighted.hunks[0].lines.find(
      (line) => line.type === "add" && line.content.includes("count"),
    );

    expect(addedLine?.tokens?.length).toBeGreaterThan(0);
  });

  it("adds syntax highlighting tokens to XML code", () => {
    const files = parseDiff(XML_DIFF);
    const highlighted = highlightDiffFile(files[0]);
    const addedLine = highlighted.hunks[0].lines.find(
      (line) => line.type === "add" && line.content.includes("<count>"),
    );

    expect(addedLine?.tokens).toContainEqual(expect.objectContaining({ style: "tag" }));
  });
});

describe("parseAndHighlightDiff", () => {
  it("parses and highlights in one step", () => {
    const files = parseAndHighlightDiff(SIMPLE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].lines[1].tokens).toContainEqual(
      expect.objectContaining({ text: "const", style: "keyword" }),
    );
  });

  it("handles multiple files", () => {
    const multiFileDiff = SIMPLE_DIFF + "\n" + NEW_FILE_DIFF;
    const files = parseAndHighlightDiff(multiFileDiff);

    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("example.ts");
    expect(files[1].path).toBe("newfile.ts");
  });
});
