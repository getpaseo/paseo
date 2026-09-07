export interface VideoPlayerProps {
  uri: string;
  active: boolean;
  onLoad(): void;
  onError(): void;
}
