/** Nathan's uploaded Broadcastify feed. Feed id is public; the account password is not. */
export const PENN_HILLS_FEED = {
  preset: "penn-hills",
  feedId: "47291",
  name: "Penn Hills / Plum Police Dispatch",
  username: "nlaero",
  genre: "Public Safety",
  county: "Allegheny",
  state: "Pennsylvania",
  lat: 40.4756,
  lon: -79.7881,
  detail: "472.5875 · Allegheny County East PD 2",
} as const;

export function isPennHillsPreset(params: Record<string, unknown>): boolean {
  if (params.preset === "custom") return false;
  if (params.preset === PENN_HILLS_FEED.preset) return true;
  return String(params.feedId ?? "").trim() === PENN_HILLS_FEED.feedId;
}

/** Feed picker. Penn Hills fills the public feed id; custom clears it so another owned feed can be typed. */
export function applyBroadcastifyPreset(
  preset: string,
  prev: Record<string, unknown>,
): Record<string, unknown> {
  if (preset === "custom") {
    const feedId = String(prev.feedId ?? "").trim();
    return {
      ...prev,
      preset: "custom",
      feedId: feedId === PENN_HILLS_FEED.feedId ? "" : (prev.feedId ?? ""),
    };
  }
  return {
    ...prev,
    preset: PENN_HILLS_FEED.preset,
    feedId: PENN_HILLS_FEED.feedId,
  };
}
