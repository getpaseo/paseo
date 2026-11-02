import React from 'react';
import './customDirectEventTypes.desktop';
import {
  Pressable,
  type ColorValue,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type DesktopButtonProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  activeOpacity?: number;
  underlayColor?: ColorValue;
  onActiveStateChange?: (active: boolean) => void;
  pressedStyle?: ViewStyle;
  borderless?: boolean;
  rippleColor?: ColorValue | number | null;
  rippleRadius?: number | null;
  foreground?: boolean;
  exclusive?: boolean;
  cancelable?: boolean;
};

function DesktopButton({
  activeOpacity = 0.75,
  onActiveStateChange,
  onPressIn,
  onPressOut,
  pressedStyle,
  style,
  ...props
}: DesktopButtonProps) {
  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        style,
        pressed ? [{ opacity: activeOpacity }, pressedStyle] : undefined,
      ]}
      onPressIn={event => {
        onActiveStateChange?.(true);
        onPressIn?.(event);
      }}
      onPressOut={event => {
        onActiveStateChange?.(false);
        onPressOut?.(event);
      }}
    />
  );
}

export const RectButton = ({ underlayColor, ...props }: DesktopButtonProps) => (
  <DesktopButton
    {...props}
    pressedStyle={
      underlayColor == null ? undefined : { backgroundColor: underlayColor }
    }
  />
);

export const BorderlessButton = (props: DesktopButtonProps) => (
  <DesktopButton {...props} />
);

export const RawButton = DesktopButton;
export const BaseButton = DesktopButton;
export const LegacyRectButton = RectButton;
export const LegacyBorderlessButton = BorderlessButton;
export const LegacyRawButton = RawButton;
export const LegacyBaseButton = BaseButton;
