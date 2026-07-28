const DEFAULT_BOTTOM_THRESHOLD = 80;

export function isNearMessageBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = DEFAULT_BOTTOM_THRESHOLD,
) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
