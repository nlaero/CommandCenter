/** A panel's place on the board grid. */
export type PanelRect = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  static?: boolean;
};

function overlaps(a: PanelRect, b: PanelRect): boolean {
  if (a.i === b.i) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * While one panel is dragged, move each panel it covers down just far enough
 * to sit clear of it. A panel that then covers another moves that one the
 * same way. Panels the drag never reaches stay put, gaps included.
 *
 * `live` is mutated. `baseline` is the layout from drag start, so a panel
 * returns if the pointer moves off it instead of keeping a shove from an
 * earlier frame. The dragged panel stays on the pointer.
 *
 * The grid's own push, with compaction off, drops the covered panel by the
 * full height of the one being dragged.
 */
export function settleCoveredPanels<T extends PanelRect>(
  live: readonly T[],
  baseline: readonly T[] | null,
  moverId: string,
): readonly T[] {
  const mover = live.find((item) => item.i === moverId);
  if (!mover || !baseline) return live;

  const start = new Map(baseline.map((item) => [item.i, item]));
  for (const item of live) {
    if (item.i === moverId) continue;
    const original = start.get(item.i);
    if (!original) continue;
    item.x = original.x;
    item.y = original.y;
    item.w = original.w;
    item.h = original.h;
  }

  const pending = live
    .filter((item) => item.i !== moverId)
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));

  const processed: T[] = [];
  const pushed: T[] = [];

  for (const item of pending) {
    if (item.static) {
      processed.push(item);
      continue;
    }

    const chain = [mover, ...pushed];
    if (!chain.some((other) => overlaps(item, other))) {
      processed.push(item);
      continue;
    }

    const obstacles = [mover, ...processed];
    for (let guard = 0; guard <= live.length; guard += 1) {
      let nextY = item.y;
      for (const other of obstacles) {
        if (!overlaps(item, other)) continue;
        const bottom = other.y + other.h;
        if (bottom > nextY) nextY = bottom;
      }
      if (nextY === item.y) break;
      item.y = nextY;
    }

    pushed.push(item);
    processed.push(item);
  }

  return live;
}
