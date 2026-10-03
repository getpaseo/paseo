import { useCallback, useRef } from "react";
import type { EditingTextInputProps } from "./types";

export function useUserInputFocus(props: EditingTextInputProps) {
  const {
    onFocus: reportFocus,
    onBlur: reportBlur,
    onTouchStart: reportTouchStart,
    onPressIn: reportPressIn,
    onUserFocus,
  } = props;
  const ignoreFocus = useRef(Boolean(props.autoFocus));
  const beforeProgrammaticFocus = useCallback(() => {
    ignoreFocus.current = true;
  }, []);
  const onFocus = useCallback<NonNullable<EditingTextInputProps["onFocus"]>>(
    (event) => {
      const programmatic = ignoreFocus.current;
      ignoreFocus.current = false;
      reportFocus?.(event);
      if (!programmatic) onUserFocus?.();
    },
    [reportFocus, onUserFocus],
  );
  const onTouchStart = useCallback<NonNullable<EditingTextInputProps["onTouchStart"]>>(
    (event) => {
      ignoreFocus.current = false;
      reportTouchStart?.(event);
      onUserFocus?.();
    },
    [reportTouchStart, onUserFocus],
  );
  const onPressIn = useCallback<NonNullable<EditingTextInputProps["onPressIn"]>>(
    (event) => {
      ignoreFocus.current = false;
      reportPressIn?.(event);
      onUserFocus?.();
    },
    [reportPressIn, onUserFocus],
  );
  const onBlur = useCallback<NonNullable<EditingTextInputProps["onBlur"]>>(
    (event) => {
      ignoreFocus.current = false;
      reportBlur?.(event);
    },
    [reportBlur],
  );
  return { beforeProgrammaticFocus, onFocus, onTouchStart, onPressIn, onBlur };
}
