/** Largest width and height of `aspect` (width / height) that fit inside a panel. */
export function fittedStillBox(
  panelWidth: number,
  panelHeight: number,
  aspect: number,
): { width: number; height: number } {
  if (
    !(panelWidth > 0) ||
    !(panelHeight > 0) ||
    !(aspect > 0) ||
    !Number.isFinite(panelWidth) ||
    !Number.isFinite(panelHeight) ||
    !Number.isFinite(aspect)
  ) {
    return { width: 0, height: 0 };
  }
  const width = Math.min(panelWidth, panelHeight * aspect);
  return { width, height: width / aspect };
}
