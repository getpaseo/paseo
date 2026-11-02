/**
 * GPUI's TextInput host uses the shared Fabric `TextInput` component. RN 0.87's
 * upstream wrapper only initializes native controls for iOS and Android, so
 * this desktop wrapper adapts the same event/value contract to GPUI.
 */
import * as React from 'react';
import { StyleSheet } from 'react-native';
import * as NativeComponentRegistry from '../../NativeComponent/NativeComponentRegistry';
import codegenNativeCommands from '../../Utilities/codegenNativeCommands';
import RCTTextInputViewConfig from './RCTTextInputViewConfig';

const NativeTextInput = NativeComponentRegistry.get('TextInput', () => ({
  ...RCTTextInputViewConfig,
  uiViewClassName: 'TextInput',
}));
const Commands = codegenNativeCommands({
  supportedCommands: ['focus', 'blur', 'clear'],
});

const TextInput = React.forwardRef(function GPUITextInput(props, ref) {
  const {
    value,
    defaultValue,
    onChange,
    onChangeText,
    onSelectionChange,
    onFocus,
    onBlur,
    selection,
    multiline = false,
    editable = true,
    autoFocus = false,
    style,
    ...nativeProps
  } = props;
  const flatStyle = StyleSheet.flatten(style) || {};
  const metric = value => (typeof value === 'number' ? value : 0);
  const fontSize =
    typeof flatStyle.fontSize === 'number' ? flatStyle.fontSize : 14;
  const lineHeight =
    typeof flatStyle.lineHeight === 'number'
      ? flatStyle.lineHeight
      : Math.max(fontSize * 1.2, fontSize * 1.4);
  const verticalPadding =
    metric(flatStyle.paddingVertical ?? flatStyle.padding) * 2 ||
    metric(flatStyle.paddingTop) + metric(flatStyle.paddingBottom);
  const verticalBorder =
    metric(flatStyle.borderTopWidth ?? flatStyle.borderWidth) +
    metric(flatStyle.borderBottomWidth ?? flatStyle.borderWidth);
  const minimumLineHeight = Math.ceil(
    lineHeight + verticalPadding + verticalBorder,
  );
  const inputStyle =
    flatStyle.height == null
      ? [{ minHeight: minimumLineHeight }, style]
      : style;
  const [uncontrolledValue, setUncontrolledValue] = React.useState(
    defaultValue == null ? '' : String(defaultValue),
  );
  const text = value == null ? uncontrolledValue : String(value);
  const nativeRef = React.useRef(null);
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    if (autoFocus && nativeRef.current) Commands.focus(nativeRef.current);
  }, [autoFocus]);

  const handleChange = React.useCallback(
    event => {
      const nextText = event.nativeEvent.text;
      if (value == null) setUncontrolledValue(nextText);
      onChangeText?.(nextText);
      onChange?.(event);
    },
    [onChange, onChangeText, value],
  );
  const handleFocus = React.useCallback(
    event => {
      focusedRef.current = true;
      onFocus?.(event);
    },
    [onFocus],
  );
  const handleBlur = React.useCallback(
    event => {
      focusedRef.current = false;
      onBlur?.(event);
    },
    [onBlur],
  );
  React.useImperativeHandle(ref, () => {
    const instance = nativeRef.current;
    if (instance == null) return null;
    // Preserve the native host instance (and its measure/setNativeProps
    // methods) while matching RN TextInput's imperative ref API.
    Object.assign(instance, {
      focus() {
        Commands.focus(instance);
      },
      blur() {
        Commands.blur(instance);
      },
      clear() {
        Commands.clear(instance);
      },
      isFocused() {
        return focusedRef.current;
      },
      getNativeRef() {
        return instance;
      },
    });
    return instance;
  }, []);

  return (
    <NativeTextInput
      {...nativeProps}
      ref={nativeRef}
      text={text}
      selection={selection}
      multiline={multiline}
      editable={editable}
      style={inputStyle}
      onChange={handleChange}
      onSelectionChange={onSelectionChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
});

TextInput.displayName = 'TextInput';
export default TextInput;
