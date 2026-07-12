export interface ProjectPickerBrowseButtonProps {
  serverId: string;
  disabled: boolean;
  onSelect: (path: string) => void;
  onError: () => void;
}
