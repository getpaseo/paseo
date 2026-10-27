import { Renderer, useRenderNode } from "@openuidev/react-lang";
import React, { useMemo, type ComponentProps } from "react";
import { validateInteractiveSource } from "@getpaseo/protocol/interactive-response";

type Props = Pick<ComponentProps<typeof Renderer>, "library"> & { source: string };
type Root = ReturnType<typeof validateInteractiveSource>;

export function getArtifactNames(source: string): string[] {
  const names: string[] = [];
  function visit(node: Root) {
    if (node.typeName === "HtmlArtifact")
      names.push(typeof node.props.name === "string" ? node.props.name : "artifact");
    if (Array.isArray(node.props.children))
      for (const child of node.props.children) visit(child as Root);
  }
  visit(validateInteractiveSource(source));
  return names;
}

function Content({ root }: { root: Root }) {
  const renderNode = useRenderNode();
  return <>{renderNode(root)}</>;
}

export function InteractiveRenderer({ source, library }: Props) {
  const root = useMemo(() => validateInteractiveSource(source), [source]);
  // OpenUI's default presentation contains DOM elements, including its native entry.
  return (
    <Renderer.Root response={source} library={library} publishObservability={false}>
      <Content root={root} />
    </Renderer.Root>
  );
}
