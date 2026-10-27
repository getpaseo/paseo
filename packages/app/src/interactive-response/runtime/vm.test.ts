import { expect, it } from "vitest";
import { createArtifactVM } from "./vm";

it("runs custom controls, restores state and only prepares proposals", async () => {
  const states: string[] = [];
  const renders: string[] = [];
  const vm = await createArtifactVM('{"state":{"count":2},"proposal":""}', {
    render: (html) => renders.push(html),
    state: (value) => states.push(value),
    failed: () => {
      throw Error("Unexpected runtime error");
    },
  });
  try {
    vm.run([
      'let count=paseo.getState().count; function draw(){paseo.render(`<button id="add">${count}</button>`)};draw();paseo.on("add","click",()=>{count++;paseo.setState({count});paseo.propose("Choose "+count);draw()});',
    ]);
    vm.event({ id: "add", type: "click", value: "", checked: false });
    expect(renders).toEqual(['<button id="add">2</button>', '<button id="add">3</button>']);
    expect(states.map((value) => JSON.parse(value))).toEqual([
      { state: { count: 3 }, proposal: "" },
      { state: { count: 3 }, proposal: "Choose 3" },
    ]);
  } finally {
    vm.dispose();
  }
});

it("has no browser privileges and interrupts infinite programs", async () => {
  const renders: string[] = [];
  const vm = await createArtifactVM(undefined, {
    render: (html) => renders.push(html),
    state: () => {},
    failed: () => {},
  });
  vm.run([
    'paseo.render([typeof fetch,typeof document,typeof window,typeof parent,typeof process,typeof WebSocket].join(","))',
  ]);
  expect(renders).toEqual(["undefined,undefined,undefined,undefined,undefined,undefined"]);
  expect(() => vm.run(["while(true){}"])).toThrow("Visual execution failed");
  vm.dispose();
});

it("rejects oversized state without publishing it", async () => {
  const states: string[] = [];
  const vm = await createArtifactVM(undefined, {
    render: () => {},
    state: (value) => states.push(value),
    failed: () => {},
  });
  try {
    expect(() => vm.run(['paseo.setState("x".repeat(65537))'])).toThrow();
    expect(states).toEqual([]);
  } finally {
    vm.dispose();
  }
});

it("does not allow direct bridge calls to bypass the timer bound", async () => {
  const vm = await createArtifactVM(undefined, {
    render: () => {},
    state: () => {},
    failed: () => {},
  });
  try {
    expect(() => vm.run(["for(let i=0;i<1000;i++) __schedule(1,60000)"])).toThrow();
  } finally {
    vm.dispose();
  }
});

it("bounds animations and stops them when a snapshot is frozen", async () => {
  const renders: string[] = [];
  let finish = () => {};
  const rendered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const vm = await createArtifactVM(undefined, {
    render: (html) => {
      renders.push(html);
      finish();
    },
    state: () => {},
    failed: () => {},
  });
  try {
    vm.run([
      'setTimeout(()=>paseo.render("animated"),32);setTimeout(()=>paseo.render("cancelled"),200)',
    ]);
    await rendered;
    vm.pause();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(renders).toEqual(["animated"]);
  } finally {
    vm.dispose();
  }
});

it("rejects excessive allocations inside the interpreter", async () => {
  const vm = await createArtifactVM(undefined, {
    render: () => {},
    state: () => {},
    failed: () => {},
  });
  try {
    expect(() =>
      vm.run(['let allocations=[];for(let n=0;n<10000;n++) allocations.push("x".repeat(100000))']),
    ).toThrow();
  } finally {
    vm.dispose();
  }
});

it("keeps runtime internals out of the generated program's lexical scope", async () => {
  const states: string[] = [];
  const vm = await createArtifactVM(undefined, {
    render: () => {},
    state: (value) => states.push(value),
    failed: () => {},
  });
  try {
    vm.run(["const callbacks=[];const timers=[];let current={count:2};paseo.setState(current)"]);
    expect(states).toEqual(['{"state":{"count":2},"proposal":""}']);
  } finally {
    vm.dispose();
  }
});
