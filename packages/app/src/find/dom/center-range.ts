/**
 * Brings a match into view without moving it when it is already there.
 *
 * Scrolling an on-screen match would make every step of a query jump the page even
 * when the reader can already see where the next match is; only a match outside the
 * scroller is centered.
 */
export function centerRange(range: Range, scrollElement: HTMLElement): void {
  const rangeRect = range.getBoundingClientRect();
  const viewRect = scrollElement.getBoundingClientRect();
  if (rangeRect.top >= viewRect.top && rangeRect.bottom <= viewRect.bottom) {
    return;
  }
  scrollElement.scrollTop +=
    rangeRect.top - viewRect.top - (viewRect.height - rangeRect.height) / 2;
}
