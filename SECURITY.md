# Security

Pilotage is a single-user app that runs on your own computer and reads sensitive material: your coding sessions,
prompts and project folders. This page says what it protects against, how, and what it does not try to do.

## Threat model

Protected against:

- **Other people on your network** (home Wi-Fi, a café, a hotel): the server listens on 127.0.0.1 only. Phones reach
  it through a forwarder that accepts only your local subnet and VPN ranges, and every request still needs a paired
  device.
- **Websites you visit** (CSRF, DNS rebinding): mutating requests need a custom header and a JSON body, which a
  cross-site page cannot send because CORS is never granted; no GET request changes anything; cookies are
  `HttpOnly` and `SameSite`; and every listener checks the `Host` header against a strict allow-list.
- **A stolen or lost phone**: devices are listed in Settings → Devices and can be revoked one by one from the PC.
  Pairing, device management, firewall changes and key rotation are refused when the request comes from a phone.
- **Leaking secrets into summaries**: tokens, passwords and keys that appear in prompts are redacted before
  anything is stored, shown or sent to an AI provider.
- **The AI doing things**: AI jobs only produce text. `claude -p` runs with no tools, no MCP servers, no slash
  commands and no session persistence, in an empty sandbox folder; `codex exec` runs read-only.

Not protected against (out of scope):

- Malware or another user account on the same computer that can read your files. `data/secrets.json` (mode 600)
  holds the device tokens' hashes, the desktop key and any API keys.
- Anyone who can use your unlocked PC: the browser on the PC is a paired device.
- What your AI provider does with the text Pilotage sends it (summaries of your prompts and the agent's replies).
  Pick the provider you trust in Settings → AI, or turn AI off.

## How authentication works

- **Paired devices.** Every page and `/api` call needs a device cookie (`HttpOnly`, `SameSite`, a 256-bit random
  token; the server stores only its hash). The PC browser gets one through `pilotage open`; a phone through
  Settings → Devices → Pair a phone.
- **One-time codes.** Pairing and login links carry a code that works once and expires after 10 minutes. The desktop
  login code only works on the PC itself, never through the phone listener. Failed attempts are rate-limited.
- **The CLI key.** `bin/pilotage` talks to the server with a desktop key read from `data/secrets.json`; it is accepted
  on the local listener only and never appears in a URL. `pilotage rotate-key` replaces it.
- **Two listeners.** The PC browser and the CLI use one loopback port; phones arrive on another. Requests on the
  phone listener cannot pair devices, manage devices, change the firewall or rotate keys.
- **CSRF.** Mutating requests need `X-Pilotage: 1` and `Content-Type: application/json`.
- **Host allow-list.** `localhost`, `127.0.0.1` and `*.localhost` on the PC listener; IP addresses and VPN host names
  (NetBird, Tailscale) on the phone listener. Anything else gets `421`.
- **Security headers.** A strict Content-Security-Policy (`default-src 'self'`), `X-Frame-Options: DENY`,
  `nosniff`, `no-referrer`, and `Cache-Control: no-store` on API responses.

## Phone access

On WSL2 + Windows, phones connect to a small forwarder on Windows (a renamed copy of `node.exe`), allowed by one
Windows Firewall rule limited to your local subnet and VPN ranges. The forwarder also checks each connection: VPN
ranges always, your Wi-Fi only while the PC is on a network you marked as trusted. See [docs/PHONE.md](docs/PHONE.md)
for the setup and for how the traffic is protected on Wi-Fi and over a VPN.

## What Pilotage reads and writes

- **Reads**, never writes: `~/.claude`, `~/.codex`, `~/.gemini`, your git repositories (git runs with
  `--no-optional-locks`, hooks and fsmonitor disabled) and project folders. It does not follow symlinks out of a
  project when showing documents, and never reads files that look like secrets (`.env`, keys, credentials) for the
  project scout or spin-off handoffs.
- **Writes**: its own `data/` folder; new folders you explicitly create (Spin off / New project), only inside your
  home folder and never inside `~/.ssh`, `~/.claude`, `~/.config` or Pilotage itself; and, if you run
  `pilotage install` on WSL, a Startup entry, a Desktop shortcut and `%LOCALAPPDATA%\Pilotage`.
- **One exception to "never writes" an agent's files**, only when you ask for it (Settings → Trust folders, or the
  "Trust this folder" checkbox when starting a session): it records Claude Code's answer to "Do you trust the files
  in this folder?" for that folder, the `hasTrustDialogAccepted` flag in `~/.claude.json`. It changes nothing else,
  takes the lock Claude Code uses for that file, replaces it in one step, and keeps the previous version in
  `data/backups/claude-config/`. Never for the home folder. See `server/claude-trust.js`.
- **Starts** coding-agent sessions only when you ask (a button or `pilotage new`), with the prompt passed through a
  file, never through a shell command line.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/Ya-zid/pilotage/security/advisories/new) rather than a public
issue. Include what you found, how to reproduce it, and what an attacker could do with it. This is a side project
maintained by one person: expect an answer within a couple of weeks, sooner for anything serious.
