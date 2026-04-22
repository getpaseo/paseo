type ScrollInvestigationEvent =
  | "scrollEvent"
  | "nearBottomTransition"
  | "metricUpdate"
  | "itemRenderCall"
  | "wheelAttach"
  | "wheelDetach"
  | "inputChange"
  | "keyPress";

export function installScrollJankInvestigation(): void {}

export function markScrollInvestigationRender(_componentId: string): void {}

export function markScrollInvestigationEvent(
  _componentId: string,
  _event: ScrollInvestigationEvent,
): void {}
