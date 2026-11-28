/**
 * @flow strict-local
 * @format
 */

import ActivityIndicator from '../ActivityIndicator/ActivityIndicator';
import View from '../View/View';
import * as React from 'react';

type Props = $ReadOnly<{
  refreshing: boolean,
  onRefresh?: ?() => void,
  tintColor?: ?string,
  colors?: ?$ReadOnlyArray<string>,
  enabled?: ?boolean,
  title?: ?string,
  ...
}>;

/**
 * Shows an indicator at the top of the scrolled content while `refreshing` is
 * true. A desktop pointer cannot pull a view past its top, so `onRefresh` is
 * not called by a gesture; set `refreshing` to start one.
 */
function RefreshControl(props: Props): React.Node {
  if (!props.refreshing) {
    return null;
  }
  return (
    <View
      style={{ alignItems: 'center', paddingVertical: 8 }}
      testID="refresh-control-indicator"
    >
      <ActivityIndicator color={props.tintColor ?? props.colors?.[0]} />
    </View>
  );
}

RefreshControl.displayName = 'RefreshControl';

export default RefreshControl;
