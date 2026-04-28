<p align="center">
  <a href="https://hubcode.ai"><img src="https://hubcode.ai/logo-hubcode.png" alt="Hubcode" width="120"/></a>
</p>

<h1 align="center">@hubcode/highlight</h1>

<p align="center">
  Lightweight syntax highlighter used by Hubcode (Lezer-based, multi-language).
</p>

## What it is

A small Lezer-based syntax highlighter used internally by Hubcode to render code blocks in diffs, chat messages, and timelines. Ships without a runtime dependency on CodeMirror.

Supported languages: JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, CSS, HTML, JSON, Markdown, XML, SQL, YAML, Sass, and more.

## Install

```bash
npm install @hubcode/highlight
```

## Usage

```ts
import { highlight } from "@hubcode/highlight";

const html = highlight("const x = 1;", "typescript");
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
