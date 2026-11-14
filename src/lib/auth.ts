import type { AppState, AuthProbe, AuthSession, AuthSettings, AuthUser } from "../types";
import { AUTH_IN_APP } from "./authFeature";

const TOKEN_KEY = "command-center.auth-tokens.v1";

type StoredTokens = {
  accessToken?: string;
  refreshToken?: string;
  username?: string;
  userId?: string;
  expiresAt?: number;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Something went wrong talking to auth-server.";
}

export function defaultAuthSettings(enabled: boolean): AuthSettings {
  return {
    enabled,
    baseUrl: "",
    allowInsecureHttp: false,
    caFile: null,
    tlsPinSha256: null,
  };
}

export function withAuth(state: AppState): AppState {
  const auth = state.auth;
  if (!auth) {
    return { ...state, auth: defaultAuthSettings(AUTH_IN_APP) };
  }
  return {
    ...state,
    auth: {
      enabled: AUTH_IN_APP,
      baseUrl: auth.baseUrl?.trim() ?? "",
      allowInsecureHttp: Boolean(auth.allowInsecureHttp),
      caFile: auth.caFile?.trim() || null,
      tlsPinSha256: auth.tlsPinSha256?.trim() || null,
    },
  };
}

function friendlyCode(code: string): string {
  switch (code) {
    case "invalid_credentials":
      return "Username or password is incorrect.";
    case "invalid_token":
      return "Session expired. Sign in again.";
    case "rate_limited":
      return "Too many attempts. Wait a few minutes and try again.";
    case "username_taken":
      return "That username is already taken.";
    case "weak_password":
      return "Password must be at least 8 characters.";
    case "registration_disabled":
      return "Registration is turned off on this auth-server.";
    case "bad_request":
      return "Check the username and password and try again.";
    case         "secret_store_disabled":
      return "This server does not store passwords or API keys. They stay on each computer.";
    case "internal":
      return "auth-server had a problem. Try again in a moment.";
    default:
      return `auth-server rejected the request (${code}).`;
  }
}

function isTailnetHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const nums = parts.map(Number);
    if (nums.some((n) => n > 255)) return false;
    return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
  }
  return host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function ipv4Parts(hostname: string): number[] | null {
  const host = bareHost(hostname);
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const nums = parts.map(Number);
  if (nums.some((part) => part > 255)) return null;
  return nums;
}

/** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. Not Tailscale and not loopback. */
function isPrivateLanHost(hostname: string): boolean {
  const nums = ipv4Parts(hostname);
  if (!nums) return false;
  if (nums[0] === 10) return true;
  if (nums[0] === 192 && nums[1] === 168) return true;
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const nums = ipv4Parts(host);
  return nums?.[0] === 127;
}

function isLabHost(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".lan")
  ) {
    return true;
  }
  if (isTailnetHost(host) || isPrivateLanHost(host) || isLoopbackHost(host)) return true;
  if (host === "::1") return true;
  const nums = ipv4Parts(host);
  if (!nums) return false;
  return nums[0] === 169 && nums[1] === 254;
}

/** Same origin rules as the desktop client, including installed builds. */
export function normalizeAuthSettings(settings: AuthSettings): AuthSettings {
  const raw = settings.baseUrl.trim();
  if (!raw) {
    throw new Error("Enter the auth-server URL, or install a server on this computer.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Auth-server URL is not a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("Auth-server URL must not include a username or password.");
  }
  if (url.search || url.hash) {
    throw new Error("Auth-server URL must not include a query or fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Auth-server URL must be an origin, without a path.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Auth-server URL must start with https:// or http://.");
  }
  const plainHttpAllowed =
    isTailnetHost(url.hostname) ||
    isPrivateLanHost(url.hostname) ||
    isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !plainHttpAllowed) {
    if (!settings.allowInsecureHttp) {
      throw new Error(
        "Auth-server URL must be https:// for a public host. Plain HTTP is allowed for private LAN addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback, and Tailscale (100.64.0.0/10). Allow HTTP also covers a named lab host (.local or .lan).",
      );
    }
    if (!isLabHost(url.hostname)) {
      throw new Error(
        "Plain HTTP is only allowed for private LAN addresses, loopback, Tailscale, or a named lab host (.local or .lan) when Allow HTTP is on.",
      );
    }
  }
  const caFile = settings.caFile?.trim() || null;
  const pin = settings.tlsPinSha256?.trim() || null;
  if (pin && !/^(?:[0-9a-fA-F]{2}:?){32}$|^(?:[0-9a-fA-F]{64})$/.test(pin.replace(/\s+/g, ""))) {
    const hex = pin.replace(/[\s:]/g, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("TLS pin must be a SHA-256 hex string (64 digits).");
    }
  }
  return {
    enabled: Boolean(settings.enabled),
    baseUrl: url.origin,
    allowInsecureHttp: Boolean(settings.allowInsecureHttp),
    caFile,
    tlsPinSha256: pin,
  };
}

function readTokens(): StoredTokens {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : {};
  } catch {
    return {};
  }
}

function writeTokens(tokens: StoredTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

function clearTokens(): void {
  const username = readTokens().username;
  if (username) writeTokens({ username });
  else localStorage.removeItem(TOKEN_KEY);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function authFetch(
  settings: AuthSettings,
  path: string,
  init: { method: string; body?: unknown; bearer?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const base = settings.baseUrl.replace(/\/$/, "");
  // Dev server proxy avoids browser CORS. The desktop app calls auth-server from Rust.
  const url = import.meta.env.DEV ? `/proxy/auth${path}` : `${base}${path}`;
  if (import.meta.env.DEV) headers["x-cc-auth-base"] = base;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new Error(
      `auth-server unreachable. Check the server URL and that this computer can reach it. (${errorMessage(err)})`,
    );
  }
  if (response.status === 204) return { status: 204, body: null };
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    if (response.ok) throw new Error("auth-server returned a response that was not JSON.");
    throw new Error(friendlyCode("bad_request"));
  }
}

function apiError(status: number, body: unknown): Error {
  const code =
    body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : status === 401
        ? "invalid_token"
        : "bad_request";
  return new Error(friendlyCode(code));
}

type TokenPayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
};

function asTokens(status: number, body: unknown): TokenPayload {
  if (status !== 200) throw apiError(status, body);
  const value = body as Partial<TokenPayload> | null;
  if (!value?.accessToken || !value.refreshToken || !value.user?.id || !value.user.username) {
    throw new Error("auth-server returned an unexpected token response.");
  }
  return value as TokenPayload;
}

function persist(tokens: TokenPayload): void {
  writeTokens({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    username: tokens.user.username,
    userId: tokens.user.id,
    expiresAt: Math.floor(Date.now() / 1000) + Number(tokens.expiresIn || 0),
  });
}

function accessFresh(tokens: StoredTokens): boolean {
  return typeof tokens.expiresAt === "number" && tokens.expiresAt > Math.floor(Date.now() / 1000);
}

function storedUser(tokens: StoredTokens): AuthUser | null {
  if (!tokens.userId || !tokens.username) return null;
  return { id: tokens.userId, username: tokens.username };
}

function sessionFrom(
  settings: AuthSettings,
  partial: Partial<AuthSession> & { signedIn: boolean },
): AuthSession {
  const tokens = readTokens();
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    allowInsecureHttp: settings.allowInsecureHttp,
    signedIn: partial.signedIn,
    offline: Boolean(partial.offline),
    user: partial.user ?? null,
    suggestedUsername: partial.suggestedUsername ?? tokens.username ?? null,
    reachable: partial.reachable ?? null,
    statusMessage: partial.statusMessage ?? null,
  };
}

async function probeWith(settings: AuthSettings): Promise<AuthProbe> {
  try {
    const normalized = normalizeAuthSettings(settings);
    const { status, body } = await authFetch(normalized, "/health", { method: "GET" });
    const ok =
      status === 200 &&
      body &&
      typeof body === "object" &&
      (body as { ok?: unknown }).ok === true;
    if (ok) return { reachable: true, message: "auth-server reachable" };
    return { reachable: false, message: `auth-server replied HTTP ${status} on /health.` };
  } catch (err) {
    return { reachable: false, message: errorMessage(err) };
  }
}

async function restore(settings: AuthSettings): Promise<AuthSession> {
  let normalized: AuthSettings;
  try {
    normalized = normalizeAuthSettings(settings);
  } catch (err) {
    return sessionFrom(settings, {
      signedIn: false,
      reachable: false,
      statusMessage: errorMessage(err),
    });
  }
  if (!normalized.enabled) {
    return sessionFrom(normalized, { signedIn: false });
  }
  const tokens = readTokens();
  if (tokens.refreshToken) {
    try {
      const response = await authFetch(normalized, "/auth/refresh", {
        method: "POST",
        body: { refreshToken: tokens.refreshToken },
      });
      const next = asTokens(response.status, response.body);
      persist(next);
      return sessionFrom(normalized, { signedIn: true, user: next.user, reachable: true });
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("unreachable")) {
        const user = storedUser(tokens);
        if (accessFresh(tokens) && user) {
          return sessionFrom(normalized, {
            signedIn: true,
            offline: true,
            user,
            reachable: false,
            statusMessage: message,
          });
        }
        return sessionFrom(normalized, {
          signedIn: false,
          reachable: false,
          statusMessage: message,
        });
      }
      if (message.includes("Session expired") || message.includes("Username or password")) {
        clearTokens();
      }
      return sessionFrom(normalized, {
        signedIn: false,
        reachable: true,
        statusMessage: message,
      });
    }
  }
  if (tokens.accessToken && accessFresh(tokens)) {
    try {
      const response = await authFetch(normalized, "/auth/me", {
        method: "GET",
        bearer: tokens.accessToken,
      });
      if (response.status !== 200) throw apiError(response.status, response.body);
      const user = response.body as AuthUser;
      writeTokens({ ...readTokens(), username: user.username, userId: user.id });
      return sessionFrom(normalized, { signedIn: true, user, reachable: true });
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("unreachable")) {
        const user = storedUser(readTokens());
        if (user) {
          return sessionFrom(normalized, {
            signedIn: true,
            offline: true,
            user,
            reachable: false,
            statusMessage: message,
          });
        }
      }
      if (message.includes("Session expired")) clearTokens();
      return sessionFrom(normalized, { signedIn: false, statusMessage: message, reachable: false });
    }
  }
  const probe = await probeWith(normalized);
  return sessionFrom(normalized, {
    signedIn: false,
    reachable: probe.reachable,
    statusMessage: probe.reachable ? null : probe.message,
  });
}

/** This build does not sign in. Avoids the auth command, which refuses the call. */
export function localSignedOutSession(): AuthSession {
  return {
    enabled: false,
    baseUrl: "",
    allowInsecureHttp: false,
    signedIn: false,
    offline: false,
    user: null,
    suggestedUsername: null,
    reachable: null,
    statusMessage: null,
  };
}

export function loadAuthSession(): Promise<AuthSession> {
  if (!AUTH_IN_APP) return Promise.resolve(localSignedOutSession());
  if (isTauri()) {
    return invoke<AuthSession>("auth_session").catch((err) => {
      throw new Error(errorMessage(err));
    });
  }
  return serialized(async () => {
    const { loadAppState } = await import("./api");
    const { state } = await loadAppState();
    return restore(withAuth(state).auth);
  });
}

export function probeAuth(): Promise<AuthProbe> {
  if (isTauri()) {
    return invoke<AuthProbe>("auth_probe").catch((err) => {
      throw new Error(errorMessage(err));
    });
  }
  return serialized(async () => {
    const { loadAppState } = await import("./api");
    const { state } = await loadAppState();
    return probeWith(withAuth(state).auth);
  });
}

export async function saveAuthSettings(settings: AuthSettings): Promise<AppState> {
  const normalized = normalizeAuthSettings({ ...settings, enabled: true });
  if (isTauri()) {
    try {
      return withAuth(await invoke<AppState>("auth_save_settings", { settings: normalized }));
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  }
  return serialized(async () => {
    const { loadAppState, saveAppState } = await import("./api");
    const { state } = await loadAppState();
    const current = withAuth(state);
    let previousOrigin = current.auth.baseUrl;
    try {
      previousOrigin = normalizeAuthSettings(current.auth).baseUrl;
    } catch {
      previousOrigin = "";
    }
    if (previousOrigin !== normalized.baseUrl) {
      const tokens = readTokens();
      if (tokens.refreshToken) {
        try {
          await authFetch(current.auth, "/auth/logout", {
            method: "POST",
            body: { refreshToken: tokens.refreshToken },
          });
        } catch {
          // Drop the local session either way so tokens are not sent to the new origin.
        }
      }
      clearTokens();
    }
    const next = { ...current, auth: normalized };
    await saveAppState(next);
    return next;
  });
}

async function submit(
  path: "/auth/register" | "/auth/login",
  username: string,
  password: string,
): Promise<AuthSession> {
  const name = username.trim();
  if (!name) throw new Error("Enter a username.");
  if (path === "/auth/register" && password.length < 8) {
    throw new Error(friendlyCode("weak_password"));
  }
  if (!password) throw new Error("Enter a password.");
  const { loadAppState } = await import("./api");
  const { state } = await loadAppState();
  const settings = withAuth(state).auth;
  if (!settings.enabled) {
    throw new Error(
      "Sign-in is turned off for this computer. Turn on Require sign-in in Settings → Account.",
    );
  }
  const response = await authFetch(settings, path, {
    method: "POST",
    body: { username: name, password },
  });
  const tokens = asTokens(response.status, response.body);
  persist(tokens);
  return sessionFrom(settings, { signedIn: true, user: tokens.user, reachable: true });
}

export function authRegister(username: string, password: string): Promise<AuthSession> {
  if (isTauri()) {
    return invoke<AuthSession>("auth_register", { username, password }).catch((err) => {
      throw new Error(errorMessage(err));
    });
  }
  return serialized(() => submit("/auth/register", username, password));
}

export function authLogin(username: string, password: string): Promise<AuthSession> {
  if (isTauri()) {
    return invoke<AuthSession>("auth_login", { username, password }).catch((err) => {
      throw new Error(errorMessage(err));
    });
  }
  return serialized(() => submit("/auth/login", username, password));
}

/** Signed-in JSON call for the browser mock. `null` when this computer is signed out. */
export function authorizedAuth(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; userId: string } | null> {
  return serialized(async () => {
    const { loadAppState } = await import("./api");
    const { state } = await loadAppState();
    const settings = normalizeAuthSettings(withAuth(state).auth);
    if (!settings.enabled) return null;
    let tokens = readTokens();
    if ((!tokens.accessToken || !accessFresh(tokens)) && tokens.refreshToken) {
      const response = await authFetch(settings, "/auth/refresh", {
        method: "POST",
        body: { refreshToken: tokens.refreshToken },
      });
      const next = asTokens(response.status, response.body);
      persist(next);
      tokens = readTokens();
    }
    if (!tokens.accessToken || !tokens.userId) return null;
    const response = await authFetch(settings, path, {
      method,
      body,
      bearer: tokens.accessToken,
    });
    return { status: response.status, body: response.body, userId: tokens.userId };
  });
}

export function storedUserId(): string | null {
  return readTokens().userId ?? null;
}

/** Access and refresh tokens, so a board upload can redact them. */
export function sessionSecretValues(): Record<string, string> {
  const tokens = readTokens();
  const values: Record<string, string> = {};
  if (tokens.accessToken && tokens.accessToken.length >= 8) {
    values["auth.access_token"] = tokens.accessToken;
  }
  if (tokens.refreshToken && tokens.refreshToken.length >= 8) {
    values["auth.refresh_token"] = tokens.refreshToken;
  }
  return values;
}

export function authLogout(): Promise<AuthSession> {
  if (isTauri()) {
    return invoke<AuthSession>("auth_logout").catch((err) => {
      throw new Error(errorMessage(err));
    });
  }
  return serialized(async () => {
    const { loadAppState } = await import("./api");
    const { state } = await loadAppState();
    const settings = withAuth(state).auth;
    const tokens = readTokens();
    let statusMessage: string | null = null;
    if (tokens.refreshToken) {
      try {
        const response = await authFetch(settings, "/auth/logout", {
          method: "POST",
          body: { refreshToken: tokens.refreshToken },
        });
        if (response.status !== 204 && response.status !== 200 && response.status !== 401) {
          throw apiError(response.status, response.body);
        }
      } catch (err) {
        const message = errorMessage(err);
        if (message.includes("unreachable")) {
          statusMessage =
            "Signed out on this computer. auth-server was unreachable, so the refresh token may still be valid there until it expires.";
        }
      }
    }
    clearTokens();
    return sessionFrom(settings, { signedIn: false, statusMessage });
  });
}
