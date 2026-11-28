/**
 * Desktop windows have no status bar. The component draws nothing and the
 * static methods do nothing, so an app written for iOS and Android keeps
 * working; React Native's own StatusBar needs a native module that desktop
 * does not have.
 *
 * @flow strict-local
 * @format
 */

import * as React from 'react';

export type StatusBarStyle =
  'default' | 'auto' | 'light-content' | 'dark-content';

export type StatusBarAnimation = 'none' | 'fade' | 'slide';

export type StatusBarProps = $ReadOnly<{
  animated?: boolean,
  backgroundColor?: ?string,
  barStyle?: ?StatusBarStyle,
  hidden?: boolean,
  networkActivityIndicatorVisible?: boolean,
  showHideTransition?: ?('fade' | 'slide' | 'none'),
  translucent?: boolean,
}>;

class StatusBar extends React.Component<StatusBarProps> {
  static currentHeight: ?number = 0;

  static setHidden(hidden: boolean, animation?: StatusBarAnimation) {}

  static setBarStyle(style: StatusBarStyle, animated?: boolean) {}

  static setNetworkActivityIndicatorVisible(visible: boolean) {}

  static setBackgroundColor(color: string, animated?: boolean) {}

  static setTranslucent(translucent: boolean) {}

  static pushStackEntry(props: StatusBarProps): StatusBarProps {
    return props;
  }

  static popStackEntry(entry: StatusBarProps) {}

  static replaceStackEntry(
    entry: StatusBarProps,
    props: StatusBarProps,
  ): StatusBarProps {
    return props;
  }

  render(): React.Node {
    return null;
  }
}

export type StatusBarInstance = StatusBar;

export default StatusBar;
