// Desktop windows have no mobile status bar. Their titlebar and decorations
// are owned by GPUI's window options, not React Native's StatusBar manager.
import * as React from 'react';
export default class StatusBar extends React.Component {
  static currentHeight = 0;
  static setHidden() {}
  static setBarStyle() {}
  static setBackgroundColor() {}
  static setTranslucent() {}
  static setNetworkActivityIndicatorVisible() {}
  static pushStackEntry(props) { return props; }
  static popStackEntry() {}
  static replaceStackEntry(_entry, props) { return props; }
  render() { return null; }
}
