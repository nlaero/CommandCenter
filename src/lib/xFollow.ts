/** Loopback callback registered on the user's own X app. Not a token. */
export const X_REDIRECT_URI = "http://127.0.0.1:8737/callback";

const CLIENT_ID = /^[A-Za-z0-9._~-]{8,128}$/;

/** The X app client ID. Access tokens are rejected so they are not saved in the board file. */
export function xClientIdError(value: string): string | null {
  const id = value.trim();
  if (!id) return "Enter the X app client ID.";
  if (!CLIENT_ID.test(id)) {
    return "Enter the X app client ID from the developer portal. That is not an access token.";
  }
  return null;
}

export function xPostLimitError(value: unknown): string | null {
  const limit = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(limit) || limit < 5 || limit > 100) {
    return "Max posts must be between 5 and 100.";
  }
  return null;
}
