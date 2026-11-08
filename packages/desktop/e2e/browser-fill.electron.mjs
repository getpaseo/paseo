import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

export async function buildFillFixture() {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../../app", import.meta.url)),
      contents: `
        import { createElement as e, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        function Form() {
          const [title, setTitle] = useState('');
          const [notes, setNotes] = useState('');
          const [submitted, setSubmitted] = useState(null);
          return e('form', { onSubmit: ev => {
            ev.preventDefault(); setSubmitted({ title, notes });
          } },
            e('input', { 'aria-label': 'React title', value: title,
              onChange: ev => setTitle(ev.target.value) }),
            e('textarea', { 'aria-label': 'React notes', value: notes,
              onChange: ev => setNotes(ev.target.value) }),
            e('p', null, 'React state: ' + JSON.stringify({ title, notes })),
            e('button', { type: 'submit' }, 'Submit'),
            e('p', null, 'Submitted: ' + JSON.stringify(submitted)));
        }
        createRoot(document.getElementById('root')).render(e(Form));
        document.getElementById('plain').addEventListener('input', ev => {
          document.getElementById('plain-state').textContent = 'Plain state: ' + ev.target.value;
        });
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return `<!doctype html><title>React fill fixture</title><div id="root"></div>
    <input aria-label="Plain input" id="plain"><p id="plain-state"></p>
    <div role="textbox" aria-label="Editable text" contenteditable="true"></div>
    <script>${outputFiles[0].text}</script>`;
}

async function findRef(call, browserId, role, name) {
  const { snapshot } = await call("browser_snapshot", { browserId });
  const line = snapshot.split("\n").find((candidate) => candidate.includes(`${role} "${name}"`));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(ref, `Snapshot must expose ${role} ${name}: ${snapshot}`).toBeTruthy();
  return ref;
}

async function fillField(call, browserId, name, value) {
  const ref = await findRef(call, browserId, "textbox", name);
  await call("browser_fill", { browserId, ref, value });
}

async function submitForm(call, browserId) {
  const ref = await findRef(call, browserId, "button", "Submit");
  await call("browser_click", { browserId, ref });
}

async function expectPageText(call, browserId, text) {
  await expect
    .poll(async () => {
      const result = await call("browser_evaluate", {
        browserId,
        function: "() => document.body.innerText",
      });
      return JSON.parse(result.resultJson);
    })
    .toContain(text);
}

export async function verifyReactFormFill(call, targetUrl) {
  const { browserId } = await call("browser_new_tab", {
    url: new URL("/react-fill", targetUrl).href,
  });
  try {
    await call("browser_wait", { browserId, text: "React state:", timeoutMs: 15_000 });
    await fillField(call, browserId, "Plain input", "plain value");
    await expectPageText(call, browserId, "Plain state: plain value");
    await fillField(call, browserId, "Editable text", "editable value");
    await expectPageText(call, browserId, "editable value");
    await fillField(call, browserId, "React title", "Hello from browser_fill");
    await fillField(call, browserId, "React notes", "First line\nSecond line");
    await expectPageText(
      call,
      browserId,
      'React state: {"title":"Hello from browser_fill","notes":"First line\\nSecond line"}',
    );
    await submitForm(call, browserId);
    await expectPageText(
      call,
      browserId,
      'Submitted: {"title":"Hello from browser_fill","notes":"First line\\nSecond line"}',
    );
    await fillField(call, browserId, "React title", "replacement");
    await fillField(call, browserId, "React notes", "");
    await submitForm(call, browserId);
    await expectPageText(call, browserId, 'Submitted: {"title":"replacement","notes":""}');
    await fillField(call, browserId, "React title", "");
    await submitForm(call, browserId);
    await expectPageText(call, browserId, 'Submitted: {"title":"","notes":""}');
  } finally {
    await call("browser_close_tab", { browserId });
  }
}
