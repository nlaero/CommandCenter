/**
 * Scrolling caption lists show the newest line first.
 * Following means the viewport is on that line. Scrolling down through older
 * lines leaves the list where it is until the user comes back to the top.
 */

const FOLLOW_SLACK_PX = 24;

/** The list is on the latest line when the user is within a few pixels of the top. */
export function captionListAtLatest(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  if (scrollHeight <= clientHeight + 1) return true;
  return scrollTop < FOLLOW_SLACK_PX;
}

/**
 * Scrolling away pauses auto-follow. Jumping back to the latest line turns it on.
 * A programmatic scroll does not change follow.
 */
export function captionFollowAfterScroll(input: {
  following: boolean;
  userScrolled: boolean;
  atLatest: boolean;
}): boolean {
  if (!input.userScrolled) return input.following;
  return input.atLatest;
}

/** Newest line first. Does not change the stored order. */
export function captionsNewestFirst<T>(lines: readonly T[]): T[] {
  return lines.length < 2 ? [...lines] : [...lines].reverse();
}

/**
 * While following, stay on the newest line. While reading older lines, a line
 * inserted at the top should not move the lines already in view.
 */
export function captionScrollTopAfterUpdate(input: {
  following: boolean;
  scrollTop: number;
  previousScrollHeight: number;
  scrollHeight: number;
}): number {
  if (input.following) return 0;
  const grew = input.scrollHeight - input.previousScrollHeight;
  if (input.previousScrollHeight > 0 && grew > 0) return input.scrollTop + grew;
  return input.scrollTop;
}
