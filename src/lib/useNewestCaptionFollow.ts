import { useLayoutEffect, useRef, useState, type UIEvent } from "react";
import {
  captionFollowAfterScroll,
  captionListAtLatest,
  captionScrollTopAfterUpdate,
  captionsNewestFirst,
} from "./captionList";

/** Keeps a scrolling caption list on the newest line until the user scrolls down. */
export function useNewestCaptionFollow<T>(lines: readonly T[]) {
  const ref = useRef<HTMLOListElement | null>(null);
  const programmatic = useRef(false);
  const previousHeight = useRef(0);
  const scrollToken = useRef(0);
  const [follow, setFollow] = useState(true);
  const shown = captionsNewestFirst(lines);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      previousHeight.current = 0;
      return;
    }
    const nextTop = captionScrollTopAfterUpdate({
      following: follow,
      scrollTop: el.scrollTop,
      previousScrollHeight: previousHeight.current,
      scrollHeight: el.scrollHeight,
    });
    previousHeight.current = el.scrollHeight;
    if (el.scrollTop === nextTop) return;
    const token = ++scrollToken.current;
    programmatic.current = true;
    el.scrollTop = nextTop;
    window.setTimeout(() => {
      if (scrollToken.current === token) programmatic.current = false;
    }, 60);
  }, [lines, follow]);

  function onScroll(event: UIEvent<HTMLOListElement>) {
    const el = event.currentTarget;
    setFollow(
      captionFollowAfterScroll({
        following: follow,
        userScrolled: !programmatic.current,
        atLatest: captionListAtLatest(el.scrollTop, el.scrollHeight, el.clientHeight),
      }),
    );
  }

  return { ref, follow, setFollow, onScroll, shown };
}
