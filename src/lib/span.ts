/** Divide one board across the screens attached to this computer. */

export const WALL_SCREEN_LIMIT = 8;

export type WallScreen = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  current: boolean;
  sharp: boolean;
};

export type SpanBox = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

export type ScreenSlice = {
  id: string;
  colStart: number;
  colCount: number;
  rowStart: number;
  rowCount: number;
};

export type WallSplit<T extends SpanBox> = {
  slices: ScreenSlice[];
  panels: { id: string; items: T[] }[];
};

export function spanRows(items: { y: number; h: number }[]): number {
  const span = items.reduce(
    (max, item) => Math.max(max, (Number(item.y) || 0) + (Number(item.h) || 0)),
    0,
  );
  return Math.max(1, Math.round(span) || 1);
}

export function normalizeWallScreens(screens: WallScreen[]): WallScreen[] {
  const out: WallScreen[] = [];
  for (const screen of screens) {
    if (!screen || typeof screen.id !== "string" || !screen.id.trim()) continue;
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) continue;
    if (!Number.isFinite(screen.width) || !Number.isFinite(screen.height)) continue;
    if (screen.width <= 0 || screen.height <= 0) continue;
    if (out.some((item) => item.id === screen.id)) continue;
    out.push(screen);
    if (out.length >= WALL_SCREEN_LIMIT) break;
  }
  return out;
}

/**
 * Map panels onto the screens.
 * Side-by-side screens divide columns. Stacked screens divide rows.
 * A gap between screens belongs to the nearer one. Each panel is on one screen.
 */
export function splitPanels<T extends SpanBox>(
  items: T[],
  screens: WallScreen[],
  cols: number,
  rows: number,
): WallSplit<T> {
  const wall = normalizeWallScreens(screens);
  const colCount = Math.max(1, Math.round(cols) || 1);
  const rowCount = Math.max(1, Math.round(rows) || 1);
  if (wall.length === 0) return { slices: [], panels: [] };

  const owners = ownerGrid(wall, colCount, rowCount);
  const slices = slicesFromOwners(wall, owners, colCount, rowCount);
  const grouped = new Map<string, T[]>(wall.map((screen) => [screen.id, []]));
  for (const item of items) {
    const col = centerIndex(item.x, item.w, colCount);
    const row = centerIndex(item.y, item.h, rowCount);
    const id = owners[row]?.[col] ?? wall[0].id;
    const slice = slices.find((entry) => entry.id === id) ?? slices[0];
    grouped.get(id)?.push(fitBox(item, slice));
  }
  return {
    slices,
    panels: wall.map((screen) => ({ id: screen.id, items: grouped.get(screen.id) ?? [] })),
  };
}

export function televisionWallDecision(
  screens: { name: string; width: number; height: number; current: boolean; sharp: boolean }[],
): { ok: boolean; reason: string } {
  if (screens.length < 2) {
    return { ok: false, reason: "Pick at least two televisions to split the board." };
  }
  for (const screen of screens) {
    if (screen.current) {
      return {
        ok: false,
        reason: "This is the computer. Setup stays here. Pick the television.",
      };
    }
    if (!screen.sharp) {
      return {
        ok: false,
        reason: `${screen.width} × ${screen.height} is below 3840 × 2160. A 58-inch or larger television would look soft. Set that display to 4K and refresh.`,
      };
    }
  }
  return {
    ok: true,
    reason: `The board splits across ${screens.length} screens. Each one is 3840 × 2160 or higher. Setup stays on this computer.`,
  };
}

export function displayWallSummary(
  screens: { name: string; width: number; height: number; current: boolean; sharp: boolean }[],
): string {
  if (screens.length < 2) return "The board stays in this window.";
  const where = screens.some((screen) => screen.current)
    ? `The board splits across ${screens.length} screens. This computer shows its part and keeps setup.`
    : `The board splits across ${screens.length} screens. Setup stays on this computer.`;
  const soft = screens.find((screen) => !screen.current && !screen.sharp);
  if (!soft) return where;
  return `${where} ${soft.name} is ${soft.width} × ${soft.height}, which is soft on a 58-inch or larger television until that display is set to 4K.`;
}

function ownerGrid(screens: WallScreen[], cols: number, rows: number): string[][] {
  if (screens.length === 1) {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => screens[0].id));
  }
  const bounds = boundsOf(screens);
  const grid: string[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const py = cellCenter(row, rows, bounds.minY, bounds.height);
    const line: string[] = [];
    for (let col = 0; col < cols; col += 1) {
      const px = cellCenter(col, cols, bounds.minX, bounds.width);
      line.push(ownerAt(screens, px, py).id);
    }
    grid.push(line);
  }
  return grid;
}

function slicesFromOwners(
  screens: WallScreen[],
  owners: string[][],
  cols: number,
  rows: number,
): ScreenSlice[] {
  if (screens.length === 1) {
    return [{ id: screens[0].id, colStart: 0, colCount: cols, rowStart: 0, rowCount: rows }];
  }
  return screens.map((screen) => {
    let colStart = cols;
    let colEnd = -1;
    let rowStart = rows;
    let rowEnd = -1;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (owners[row][col] !== screen.id) continue;
        colStart = Math.min(colStart, col);
        colEnd = Math.max(colEnd, col);
        rowStart = Math.min(rowStart, row);
        rowEnd = Math.max(rowEnd, row);
      }
    }
    if (colEnd < 0) {
      return { id: screen.id, colStart: 0, colCount: 1, rowStart: 0, rowCount: 1 };
    }
    return {
      id: screen.id,
      colStart,
      colCount: colEnd - colStart + 1,
      rowStart,
      rowCount: rowEnd - rowStart + 1,
    };
  });
}

function boundsOf(screens: WallScreen[]): { minX: number; minY: number; width: number; height: number } {
  const minX = Math.min(...screens.map((screen) => screen.x));
  const minY = Math.min(...screens.map((screen) => screen.y));
  const maxX = Math.max(...screens.map((screen) => screen.x + screen.width));
  const maxY = Math.max(...screens.map((screen) => screen.y + screen.height));
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function cellCenter(index: number, count: number, origin: number, span: number): number {
  return origin + ((index + 0.5) / count) * span;
}

function ownerAt(screens: WallScreen[], px: number, py: number): WallScreen {
  const inside = screens.filter((screen) => contains(screen, px, py));
  const pool = inside.length > 0 ? inside : screens;
  return [...pool].sort((a, b) => compareOwner(a, b, px, py))[0];
}

function compareOwner(a: WallScreen, b: WallScreen, px: number, py: number): number {
  const dist = distanceTo(a, px, py) - distanceTo(b, px, py);
  if (dist !== 0) return dist;
  const aCenter = (a.x + a.width / 2 - px) ** 2 + (a.y + a.height / 2 - py) ** 2;
  const bCenter = (b.x + b.width / 2 - px) ** 2 + (b.y + b.height / 2 - py) ** 2;
  if (aCenter !== bCenter) return aCenter - bCenter;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function contains(screen: WallScreen, px: number, py: number): boolean {
  return (
    px >= screen.x &&
    px < screen.x + screen.width &&
    py >= screen.y &&
    py < screen.y + screen.height
  );
}

function distanceTo(screen: WallScreen, px: number, py: number): number {
  const dx =
    px < screen.x ? screen.x - px : px >= screen.x + screen.width ? px - (screen.x + screen.width) : 0;
  const dy =
    py < screen.y ? screen.y - py : py >= screen.y + screen.height ? py - (screen.y + screen.height) : 0;
  return dx * dx + dy * dy;
}

function centerIndex(origin: number, size: number, count: number): number {
  const start = Number.isFinite(origin) ? origin : 0;
  const span = Number.isFinite(size) && size > 0 ? size : 1;
  const index = Math.floor(start + span / 2);
  return Math.min(count - 1, Math.max(0, index));
}

function fitBox<T extends SpanBox>(item: T, slice: ScreenSlice): T {
  let x = Math.round(item.x) - slice.colStart;
  let y = Math.round(item.y) - slice.rowStart;
  let w = Math.round(item.w);
  let h = Math.round(item.h);
  if (!Number.isFinite(w) || w < 1) w = 1;
  if (!Number.isFinite(h) || h < 1) h = 1;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  if (w > slice.colCount) w = slice.colCount;
  if (h > slice.rowCount) h = slice.rowCount;
  const minW = Math.min(Math.max(1, item.minW ?? 1), w, slice.colCount);
  const minH = Math.min(Math.max(1, item.minH ?? 1), h, slice.rowCount);
  if (x + w > slice.colCount) x = Math.max(0, slice.colCount - w);
  if (y + h > slice.rowCount) y = Math.max(0, slice.rowCount - h);
  return { ...item, x, y, w, h, minW, minH };
}
