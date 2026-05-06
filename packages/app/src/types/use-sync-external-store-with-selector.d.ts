declare module "use-sync-external-store/shim/with-selector" {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: () => Snapshot,
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (left: Selection, right: Selection) => boolean,
  ): Selection;
}
