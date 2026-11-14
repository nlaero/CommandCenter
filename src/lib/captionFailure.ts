/**
 * Plain-text reason for a failed on-device caption.
 *
 * The desktop command rejects with `{ message }`, not an Error. Stringifying
 * that object is "[object Object]". A known reason is shown as written.
 */

export function captionFailureText(err: unknown): string {
  const text = describeCaptionFailure(err, new Set());
  if (!text || text === "[object Object]") {
    return "Couldn't create captions on this device.";
  }
  return text;
}

function describeCaptionFailure(err: unknown, seen: Set<unknown>): string {
  if (typeof err === "string") {
    const trimmed = err.trim();
    if (!trimmed || trimmed === "[object Object]") return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const inner = describeCaptionFailure(JSON.parse(trimmed) as unknown, seen);
        if (inner) return inner;
      } catch {
        // A sentence that starts with a brace is already plain text.
      }
    }
    return trimmed;
  }
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (!err || typeof err !== "object") return "";
  if (seen.has(err)) return "";
  seen.add(err);
  const record = err as Record<string, unknown>;
  if (err instanceof Error) {
    const fromMessage = describeCaptionFailure(err.message, seen);
    if (fromMessage) return fromMessage;
  }
  if ("message" in record) {
    const inner = describeCaptionFailure(record.message, seen);
    if (inner) return inner;
  }
  if ("error" in record) {
    const inner = describeCaptionFailure(record.error, seen);
    if (inner) return inner;
  }
  return "";
}
