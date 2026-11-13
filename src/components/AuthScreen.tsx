import { useEffect, useState } from "react";
import {
  authLogin,
  authLogout,
  authRegister,
  errorMessage,
  loadAuthSession,
  probeAuth,
  saveAuthSettings,
} from "../lib/auth";
import type { AppState, AuthSession, AuthSettings } from "../types";

type Mode = "signin" | "register";

type Props = {
  settings: AuthSettings;
  session: AuthSession;
  onSession: (session: AuthSession) => void;
  onState: (state: AppState) => void;
};

export function AuthScreen({ settings, session, onSession, onState }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState(session.suggestedUsername ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(settings.allowInsecureHttp);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [reachable, setReachable] = useState<boolean | null>(session.reachable ?? null);
  const [status, setStatus] = useState(session.statusMessage ?? "");
  const [error, setError] = useState<string | null>(session.statusMessage ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setAllowInsecureHttp(settings.allowInsecureHttp);
    setEnabled(settings.enabled);
  }, [settings.baseUrl, settings.allowInsecureHttp, settings.enabled]);

  useEffect(() => {
    if (session.suggestedUsername && !username) {
      setUsername(session.suggestedUsername);
    }
    // Prefill once from a restored username; don't clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.suggestedUsername]);

  async function persistDraft(nextEnabled = enabled): Promise<AppState | null> {
    const next = await saveAuthSettings({
      ...settings,
      enabled: nextEnabled,
      baseUrl,
      allowInsecureHttp,
    });
    onState(next);
    return next;
  }

  async function checkServer() {
    setBusy(true);
    setError(null);
    try {
      await persistDraft();
      const probe = await probeAuth();
      setReachable(probe.reachable);
      setStatus(probe.message);
      const restored = await loadAuthSession();
      onSession(restored);
      if (restored.statusMessage) setError(restored.statusMessage);
    } catch (err) {
      setReachable(false);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await persistDraft(true);
      const next =
        mode === "register"
          ? await authRegister(username, password)
          : await authLogin(username, password);
      setPassword("");
      setConfirm("");
      onSession(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const next = await persistDraft(false);
      if (next) {
        const sessionNext = await loadAuthSession();
        onSession(sessionNext);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const reachClass =
    reachable == null ? "pending" : reachable ? "ok" : "bad";
  const reachText =
    status ||
    (reachable == null
      ? "Not checked yet"
      : reachable
        ? "auth-server reachable"
        : "auth-server unreachable");

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void onSubmit(event)}>
        <div className="brand auth-brand">
          Command <span>Center</span>
        </div>
        <h1 id="auth-title">Sign in</h1>
        <p className="auth-lead">
          Create an account or sign in. The board stays on this computer. Source API keys stay in
          the OS keyring and are not sent to auth-server.
        </p>

        <div className={`auth-reach ${reachClass}`} role="status">
          <span className="auth-dot" aria-hidden="true" />
          <span>{reachText}</span>
        </div>

        <div className="auth-modes" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={mode === "signin" ? "active" : ""}
            onClick={() => {
              setMode("signin");
              setError(null);
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
          >
            Create account
          </button>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="auth-username">Username</label>
            <input
              id="auth-username"
              name="username"
              autoComplete="username"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="auth-password">
              Password <span className="req">*</span>
            </label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={mode === "register" ? 8 : undefined}
            />
            {mode === "register" ? (
              <div className="help">At least 8 characters.</div>
            ) : null}
          </div>
          {mode === "register" ? (
            <div className="field">
              <label htmlFor="auth-confirm">
                Confirm password <span className="req">*</span>
              </label>
              <input
                id="auth-confirm"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="alert error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
          </button>
        </div>

        <div className="auth-server">
          <p className="section-label">Auth-server</p>
          <div className="field">
            <label htmlFor="auth-base-url">Server URL</label>
            <input
              id="auth-base-url"
              name="auth-base-url"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="help">
              Starts at <code>http://100.101.141.93:8080</code>. Change it if your auth-server is
              somewhere else. Plain HTTP is allowed for that tailnet address (100.64.0.0/10). Other
              addresses should use HTTPS.
            </div>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={allowInsecureHttp}
              onChange={(event) => setAllowInsecureHttp(event.target.checked)}
            />
            <span>
              Allow HTTP for a lab host (localhost or private LAN). Release builds still refuse
              that except for the tailnet address.
            </span>
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void checkServer()}
            >
              Check server
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void turnOff()}>
              Use this computer without an account
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

type AccountProps = {
  state: AppState;
  session: AuthSession;
  onState: (state: AppState) => void;
  onSession: (session: AuthSession) => void;
};

export function AccountSettings({ state, session, onState, onSession }: AccountProps) {
  const [baseUrl, setBaseUrl] = useState(state.auth.baseUrl);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(state.auth.allowInsecureHttp);
  const [caFile, setCaFile] = useState(state.auth.caFile ?? "");
  const [pin, setPin] = useState(state.auth.tlsPinSha256 ?? "");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBaseUrl(state.auth.baseUrl);
    setAllowInsecureHttp(state.auth.allowInsecureHttp);
    setCaFile(state.auth.caFile ?? "");
    setPin(state.auth.tlsPinSha256 ?? "");
  }, [state.auth]);

  async function save(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveAuthSettings({
        enabled,
        baseUrl,
        allowInsecureHttp,
        caFile: caFile.trim() || null,
        tlsPinSha256: pin.trim() || null,
      });
      onState(next);
      const refreshed = await loadAuthSession();
      onSession(refreshed);
      setMessage({ kind: "ok", text: "Saved auth-server settings." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage(null);
    try {
      const next = await authLogout();
      onSession(next);
      setMessage({
        kind: "ok",
        text: next.statusMessage ?? "Signed out on this computer.",
      });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="section-label">Account</p>
      <p className="auth-copy">
        {session.signedIn && session.user
          ? `Signed in as ${session.user.username}${session.offline ? " (offline)" : ""}.`
          : "Not signed in."}{" "}
        Username and password are checked by auth-server. Broadcastify and other source secrets
        stay in the OS keyring and are not sent there.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={state.auth.enabled}
          disabled={busy}
          onChange={(event) => void save(event.target.checked)}
        />
        <span>Require sign-in on this computer</span>
      </label>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="account-base-url">Auth-server URL</label>
          <input
            id="account-base-url"
            spellCheck={false}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <div className="help">
            Default <code>http://100.101.141.93:8080</code>. Plain HTTP is allowed for that
            tailnet address. Use HTTPS for any other host.
          </div>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(event) => setAllowInsecureHttp(event.target.checked)}
          />
          <span>Allow HTTP for a lab host (localhost or private LAN)</span>
        </label>
        <div className="field">
          <label htmlFor="account-ca">CA file (optional)</label>
          <input
            id="account-ca"
            spellCheck={false}
            placeholder="Path to a PEM CA, if it is not in the system trust store"
            value={caFile}
            onChange={(event) => setCaFile(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="account-pin">TLS pin SHA-256 (optional)</label>
          <input
            id="account-pin"
            spellCheck={false}
            placeholder="Leaf certificate or SPKI, hex"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
        </div>
      </div>
      {message ? <div className={`alert ${message.kind}`}>{message.text}</div> : null}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(state.auth.enabled)}>
          Save
        </button>
        {session.signedIn ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        ) : null}
      </div>
    </>
  );
}
