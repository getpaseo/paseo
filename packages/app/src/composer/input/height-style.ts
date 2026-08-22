interface ComposerInputHeightStyleInput {
  inputHeight: number;
  minInputHeight: number;
  maxInputHeight: number;
  applyMeasuredHeight: boolean;
}

export function resolveComposerInputHeightStyle(input: ComposerInputHeightStyleInput) {
  // Native must remain intrinsically sized below the cap so
  // onContentSizeChange can observe growth. Web gets its height from the DOM
  // mirror and therefore needs that measurement applied explicitly.
  return {
    ...(input.applyMeasuredHeight ? { height: input.inputHeight } : {}),
    minHeight: input.minInputHeight,
    maxHeight: input.maxInputHeight,
  };
}

export function shouldScrollComposerInput(input: {
  inputHeight: number;
  maxInputHeight: number;
}): boolean {
  return input.inputHeight >= input.maxInputHeight;
}
