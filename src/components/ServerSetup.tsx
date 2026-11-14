import { useEffect, useState } from "react";
import { errorMessage } from "../lib/auth";
import {
  exportLocalServerBackup,
  importLocalServerBackup,
  installLocalServer,
  localServerStatus,
  openLocalServerAdmin,
  setLocalServerSecrets,
  startLocalServer,
  stopLocalServer,
  type LocalServerStatus,
  type ServerRole,
  type ServerStartup,
} from "../lib/localServer";
import type { AppState } from "../types";

type Props = {
  onState: (state: AppState) => void;
};

export function ServerSetup({ onState }: Props) {
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState<"role" | "startup" | "admin">("role");
  const [role, setRole] = useState<ServerRole>("device");
  const [startup, setStartup] = useState<ServerStartup>("login");
  const [storeSecrets, setStoreSecrets] = useState(false);
  const [port, setPort] = useState("8080");
  const [adminUser, setAdminUser] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [adminPassAgain, setAdminPassAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancel = false;
    localServerStatus()
      .then((next) => {
        if (!cancel) setStatus(next);
      })
      .catch((err) => {
        if (!cancel) setMessage({ kind: "error", text: errorMessage(err) });
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function refresh() {
    const next = await localServerStatus();
    setStatus(next);
    return next;
  }

  async function install() {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setMessage({ kind: "error", text: "Port must be between 1 and 65535." });
      return;
    }
    if (!adminUser.trim() || adminPass.length < 8) {
      setMessage({
        kind: "error",
        text: "Create a server admin during install. This account is for the server and its settings, not a Command Center board login. Use at least 8 characters.",
      });
      return;
    }
    if (adminPass !== adminPassAgain) {
      setMessage({ kind: "error", text: "The server admin passwords do not match." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await installLocalServer({
        role,
        storeSecrets: role === "device" && storeSecrets,
        port: parsed,
        startup,
        adminUsername: adminUser.trim(),
        adminPassword: adminPass,
      });
      setAdminPass("");
      setAdminPassAgain("");
      setStatus(result.status);
      onState(result.state);
      setWizard(false);
      setMessage({
        kind: "ok",
        text:
          role === "device"
            ? "Server is running on this computer."
            : "Server is running for other devices. They use the address below.",
      });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleRun() {
    if (!status) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = status.running ? await stopLocalServer() : await startLocalServer();
      setStatus(next);
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleSecrets(next: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await setLocalServerSecrets(next);
      setStatus(result.status);
      onState(result.state);
      setStoreSecrets(next);
      setMessage({
        kind: "ok",
        text: next
          ? "Passwords and API keys for sources will be stored on this server."
          : "Passwords and API keys stay on this computer.",
      });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function exportBackup() {
    setBusy(true);
    setMessage(null);
    try {
      const file = await exportLocalServerBackup();
      const blob = new Blob([file.document], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "command-center-auth-backup.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage({
        kind: "ok",
        text: `Backup saved. A copy is also at ${file.path}. It can include account data and any passwords or API keys stored on this server.`,
      });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const document = await file.text();
      const next = await importLocalServerBackup(document);
      setStatus(next);
      await refresh();
      setMessage({
        kind: "ok",
        text: "Backup imported. Sign in again if this replaced the accounts on the server.",
      });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const installed = status?.installed;
  const roleLabel =
    status?.role === "device"
      ? "This computer only"
      : status?.role === "shared"
        ? "Server for other devices"
        : null;
  const startupLabel =
    status?.startup === "service"
      ? "Windows service"
      : status?.startup === "login"
        ? "Starts at login"
        : null;

  return (
    <div className="server-setup">
      <p className="section-label">Server on this computer</p>
      <p className="auth-copy">
        Command Center always uses a server. Connect to one you already have, or run one here.
        A server for this computer only may store source passwords and API keys. A server for
        other devices does not — those stay on each computer. Every server installed here can
        export and import a backup.
      </p>

      {status?.message ? (
        <div className="alert error" role="alert">
          {status.message}
        </div>
      ) : null}

      {!installed ? (
        <>
          {!wizard ? (
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => setWizard(true)}>
                Install a server on this computer
              </button>
            </div>
          ) : (
            <div
              className="server-wizard"
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                  event.preventDefault();
                }
              }}
            >
              {step === "role" ? (
              <>
              <div className="choice-grid" role="radiogroup" aria-label="Who is this server for?">
                <button
                  type="button"
                  role="radio"
                  aria-checked={role === "device"}
                  className={role === "device" ? "choice-card active" : "choice-card"}
                  onClick={() => setRole("device")}
                >
                  <strong>This computer only</strong>
                  <span>Other devices cannot connect. You can store passwords and API keys on it.</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={role === "shared"}
                  className={role === "shared" ? "choice-card active" : "choice-card"}
                  onClick={() => {
                    setRole("shared");
                    setStoreSecrets(false);
                  }}
                >
                  <strong>A server for other devices</strong>
                  <span>
                    Command Center on other computers can sign in here. Passwords and API keys stay
                    on each computer.
                  </span>
                </button>
              </div>

              {role === "device" ? (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={storeSecrets}
                    onChange={(event) => setStoreSecrets(event.target.checked)}
                  />
                  <span>Store source passwords and API keys on this server</span>
                </label>
              ) : null}

              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="server-port">Port</label>
                <input
                  id="server-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={() => setStep("startup")}>
                  Continue
                </button>
                <button type="button" className="btn" onClick={() => setWizard(false)}>
                  Cancel
                </button>
              </div>
              </>
              ) : null}

              {step === "startup" ? (
                <>
                  <p className="auth-copy">
                    Choose how this server runs on Windows. A service stays up when nobody is
                    signed in. Start at login puts an icon in the taskbar.
                  </p>
                  <div className="choice-grid" role="radiogroup" aria-label="How should the server start?">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={startup === "service"}
                      className={startup === "service" ? "choice-card active" : "choice-card"}
                      onClick={() => setStartup("service")}
                    >
                      <strong>Windows service</strong>
                      <span>
                        Runs in the background even when nobody is signed in. No taskbar icon.
                        Windows will ask for administrator approval.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={startup === "login"}
                      className={startup === "login" ? "choice-card active" : "choice-card"}
                      onClick={() => setStartup("login")}
                    >
                      <strong>Start at login</strong>
                      <span>
                        Starts when you sign in to Windows and shows an icon in the taskbar. Open
                        server settings from that icon.
                      </span>
                    </button>
                  </div>
                  <div className="form-actions">
                    <button type="button" className="btn btn-primary" onClick={() => setStep("admin")}>
                      Continue
                    </button>
                    <button type="button" className="btn" onClick={() => setStep("role")}>
                      Back
                    </button>
                  </div>
                </>
              ) : null}

              {step === "admin" ? (
                <>
                  <p className="auth-copy">
                    Create the server admin. This account is only for the server and its settings.
                    It is not a Command Center board login. You still create or sign in to a board
                    account in Command Center.
                  </p>
                  <div className="field">
                    <label htmlFor="server-admin-user">Server admin username</label>
                    <input
                      id="server-admin-user"
                      autoComplete="off"
                      value={adminUser}
                      onChange={(event) => setAdminUser(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="server-admin-pass">Server admin password</label>
                    <input
                      id="server-admin-pass"
                      type="password"
                      autoComplete="new-password"
                      value={adminPass}
                      onChange={(event) => setAdminPass(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="server-admin-pass-again">Confirm server admin password</label>
                    <input
                      id="server-admin-pass-again"
                      type="password"
                      autoComplete="new-password"
                      value={adminPassAgain}
                      onChange={(event) => setAdminPassAgain(event.target.value)}
                    />
                  </div>
                  <div className="form-actions">
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install()}>
                      {busy ? "Installing…" : "Install server"}
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setStep("startup")}>
                      Back
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <>
          <div className={`auth-reach ${status?.running ? "ok" : "bad"}`} role="status">
            <span className="auth-dot" aria-hidden="true" />
            <span>
              {status?.running ? "Running" : "Stopped"}
              {roleLabel ? ` · ${roleLabel}` : ""}
              {startupLabel ? ` · ${startupLabel}` : ""}
              {status?.baseUrl ? ` · ${status.baseUrl}` : ""}
            </span>
          </div>
          {status?.role === "shared" && status.lanAddress ? (
            <p className="auth-copy">
              Other devices use <code>{status.lanAddress}</code>. Allow that port through the
              firewall if they cannot connect.
            </p>
          ) : null}
          {status?.role === "device" ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={status.storeSecrets}
                disabled={busy}
                onChange={(event) => void toggleSecrets(event.target.checked)}
              />
              <span>Store source passwords and API keys on this server</span>
            </label>
          ) : (
            <p className="auth-copy">Passwords and API keys stay on each computer.</p>
          )}
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void toggleRun()}>
              {status?.running ? "Stop server" : "Start server"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void openLocalServerAdmin().catch((err) =>
                  setMessage({ kind: "error", text: errorMessage(err) }),
                )
              }
            >
              Open server settings
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void exportBackup()}>
              Export backup
            </button>
            <label className="btn">
              Import backup
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void importBackup(file);
                }}
              />
            </label>
          </div>
        </>
      )}

      {message ? (
        <div className={`alert ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
