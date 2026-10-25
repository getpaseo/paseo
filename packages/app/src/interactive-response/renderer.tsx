import { Renderer, useRenderNode } from "@openuidev/react-lang";
import React, { useMemo, type ComponentProps } from "react";
import { validateInteractiveSource } from "@getpaseo/protocol/interactive-response";

type Props = Pick<ComponentProps<typeof Renderer>, "library"> & { source: string };
type Root = ReturnType<typeof validateInteractiveSource>;

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
