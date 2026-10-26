// Native builds target iOS and Android; mouse input is filtered per gesture event.
export function useHasTouchScreen(): boolean {
  return true;
}
