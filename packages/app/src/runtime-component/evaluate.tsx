import { transform } from "@babel/standalone";
import * as React from "react";
import type { ComponentType, ReactElement } from "react";
import * as ReactNative from "react-native";

interface RuntimeModule {
  exports: unknown;
}

const RUNTIME_MODULES = new Map<string, unknown>([
  ["react", React],
  ["react-native", ReactNative],
]);

function requireRuntimeModule(name: string): unknown {
  if (!RUNTIME_MODULES.has(name)) {
    throw new Error(`Module "${name}" is not available in the runtime component.`);
  }
  return RUNTIME_MODULES.get(name);
}

function readDefaultExport(moduleExports: unknown): unknown {
  if (typeof moduleExports !== "object" || moduleExports === null) {
    return moduleExports;
  }
  if ("default" in moduleExports) {
    return moduleExports.default;
  }
  return moduleExports;
}

export function evaluateRuntimeComponent(source: string): ComponentType {
  const compiled = transform(source, {
    filename: "user-component.tsx",
    plugins: ["transform-modules-commonjs"],
    presets: [
      ["typescript", { allExtensions: true, isTSX: true }],
      ["react", { runtime: "classic" }],
    ],
    sourceType: "module",
  }).code;

  if (compiled === undefined) {
    throw new Error("Babel produced no JavaScript for the component.");
  }

  const evaluateScript: (script: string) => unknown = globalThis.eval;
  const moduleFactory = evaluateScript(
    `(function(require, module, exports) { "use strict";\n${compiled}\n})`,
  );
  if (typeof moduleFactory !== "function") {
    throw new Error("The compiled component did not produce a module factory.");
  }

  const runtimeModule: RuntimeModule = { exports: {} };
  moduleFactory(requireRuntimeModule, runtimeModule, runtimeModule.exports);
  const authoredComponent = readDefaultExport(runtimeModule.exports);
  if (typeof authoredComponent !== "function") {
    throw new Error("The source must default-export a function component.");
  }
  const renderAuthoredComponent = authoredComponent;

  function RuntimeComponent(): ReactElement {
    const rendered: unknown = renderAuthoredComponent();
    if (!React.isValidElement(rendered)) {
      throw new Error("The authored component must return one React element.");
    }
    return rendered;
  }

  RuntimeComponent.displayName = "RuntimeComponent";
  return RuntimeComponent;
}
