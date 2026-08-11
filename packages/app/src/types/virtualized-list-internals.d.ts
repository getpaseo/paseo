declare module "@react-native/virtualized-lists/Lists/boundRetainedRangeOnDataGrowth" {
  export function boundRetainedRangeOnDataGrowth(
    cellsAroundViewport: { first: number; last: number },
    previousItemCount: number,
    itemCount: number,
    retainedCellLimit: number,
  ): { first: number; last: number };
}
