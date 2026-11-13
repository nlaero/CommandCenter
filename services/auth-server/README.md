# auth-server

Command Center **auth-server**: username/password login and token issuance for the desktop app.

- **Service / binary name:** `auth-server` (never call this “Pi auth” / “Pi server”)
- **Intended GitHub repo:** `nlaero/command-center-auth`
- **Test host (not the product name):** Fedora on a Raspberry Pi (any LAN Linux host works)

This service does **not** store Broadcastify or other source API credentials. Those stay on the desktop OS keyring. See the project design doc `auth-login-design.md`.

## API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | `{ "ok": true, "service": "auth-server" }` |
| `POST` | `/auth/login` | `{ username, password }` → tokens |
| `POST` | `/auth/refresh` | `{ refreshToken }` → rotated pair |
| `POST` | `/auth/logout` | `{ refreshToken? }` → 204 |
| `GET` | `/auth/me` | Bearer access → `{ id, username }` |

Full contract: [`openapi.yaml`](./openapi.yaml).

## Local lab run

```bash
cd services/auth-server   # or repo root once extracted to command-center-auth
cp .env.example .env
# edit AUTH_JWT_SECRET
cargo run --bin authctl -- create-user nathan
cargo run --bin auth-server
curl -s http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"nathan","password":"your-password"}'
```

Lab tokens use **HS256** + `AUTH_JWT_SECRET`. Upgrade to Ed25519/RS256 before wider use (`authctl rotate-keys` prints the lab procedure).

## Fedora test-host install (sketch)

1. Build release binaries on the host (or cross-compile): `cargo build --release`
2. Install: `auth-server` + `authctl` → `/usr/local/bin/`
3. User/data: `useradd -r -d /var/lib/auth-server auth-server` and `/var/lib/auth-server`
4. Env: copy `deploy/auth-server.env.example` → `/etc/auth-server.env` (mode 600)
5. Unit: copy `deploy/auth-server.service` → `/etc/systemd/system/` and `systemctl enable --now auth-server`
6. TLS: put Caddy (or nginx) in front using `deploy/Caddyfile.example` + mkcert/step-ca; point desktops at `https://auth-server.local:8443`

## Extract to `nlaero/command-center-auth`

This tree is **extract-ready** and has no dependency on the Tauri desktop crate.

1. Create empty private repo `nlaero/command-center-auth` on GitHub (as Nathan — cloud agent tokens cannot `createRepository`).
2. Copy **this directory’s contents** to the new repo root:

```bash
git clone https://github.com/nlaero/command-center-auth.git
cd command-center-auth
cp -a /path/to/CommandCenter/services/auth-server/. .
git add .
git commit -m "Initial auth-server scaffold"
git push -u origin main
```

3. Remove `services/auth-server/` from `CommandCenter` in a follow-up PR; leave a README pointer to the new repo.

## Scope note

Scaffold includes working login/refresh/logout/me, Argon2id, SQLite, refresh rotation + reuse revoke, and a basic login rate limiter. Not yet: asymmetric JWT, TTY-hidden `authctl` passwords, production-hardened rate limits, or open registration UI.
