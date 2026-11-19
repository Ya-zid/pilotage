# Pilotage on your phone

Pilotage runs on your PC. Your phone opens it in the browser over your home Wi-Fi or a VPN (NetBird or Tailscale),
and can install it as an app. Nothing is reachable from the internet.

- [How phone access works](#how-phone-access-works)
- [Pairing a phone](#pairing-a-phone)
- [Installing Pilotage as an app (HTTPS)](#installing-pilotage-as-an-app-https)
- [Linux and macOS](#linux-and-macos)
- [Security notes](#security-notes)

## How phone access works

The server only listens on the PC itself (127.0.0.1):

| Port | Who uses it |
| --- | --- |
| 4747 | the PC browser and the `pilotage` command |
| 4746 | phones only: the "phone listener" (it refuses PC-only actions) |
| 4748 | what the phone actually connects to (Windows forwarder, or a direct bind on Linux/macOS) |

**On WSL + Windows**, a small forwarder runs on Windows (`%LOCALAPPDATA%\Pilotage\pilotage-forwarder.exe`, a copy of
`node.exe`). It listens on `0.0.0.0:4748` and pipes each allowed TCP connection to `127.0.0.1:4746`, which Windows
relays into WSL. It's a raw byte pipe, so plain HTTP and HTTPS both pass through unchanged. It decides per connection,
before forwarding a single byte:

- **NetBird / Tailscale peers**: always allowed. These are encrypted WireGuard tunnels, and they work from anywhere.
- **Wi-Fi / Ethernet neighbours**: only while the PC is on one of your *trusted* Wi-Fi networks (your home). Cafés,
  hotels and campus networks never get in.

A Windows Firewall rule (added once with an admin prompt: **Settings → Phone & security → Enable phone access**, or
`pilotage phone`) allows TCP 4748 for that one program, only from your Wi-Fi subnet and the VPN ranges.

On the phone listener, every page and API call needs a paired device, and the PC-only actions (pairing, the device
list, firewall and forwarder, keys) are refused even for a paired phone. The only things served without sign-in are
`/healthz`, the pairing links, static icons and the manifest, and the Pilotage certificate (`/pilotage-ca.crt`, public).

**Home Wi-Fi or VPN?** At home, Wi-Fi is fastest. Away, use NetBird (or Tailscale): install it on the PC and the phone,
and make sure your NetBird access policy lets the phone reach the PC on TCP 4748. Settings → Phone & security lists the
addresses for both.

## Pairing a phone

1. On the PC: **Settings → Devices → Pair a phone** (or `pilotage pair` in a terminal).
2. Scan the QR code with the phone (on your trusted Wi-Fi, or with NetBird on).
3. The phone gets a sign-in cookie for one year. Codes work once and expire after 10 minutes.

Once the Pilotage certificate exists, the pairing QR code uses **https**. A phone that doesn't have the certificate yet
would see a warning there: switch the dialog to **Plain (http)**. Pairing works the same over both.

## Installing Pilotage as an app (HTTPS)

Browsers only offer **Install app** (and only run the offline page) on a *secure* address. Plain `http://192.168.x.x`
isn't one. So the phone listener also speaks HTTPS, **on the same port 4748**: it looks at the first byte of each
connection (a TLS handshake starts with `0x16`) and hands it to the HTTPS or the HTTP server. Every check (allowed
hosts, sign-in, PC-only actions) is identical for both. Plain http keeps working, so nothing breaks before the
certificate is installed.

The HTTPS certificate comes from a small certificate authority that Pilotage creates on your PC the first time it
starts (`data/tls/`). Your phone has to trust it once.

On the PC, open **Settings → Phone & security → Install Pilotage as an app**. It shows two QR codes for the network
you pick (Wi-Fi or NetBird): **1 · Get the certificate** (an http link, since the phone doesn't trust https yet) and
**2 · Open the secure address**, plus the certificate's SHA-256 fingerprint. The same steps appear on the phone in
Settings, with buttons instead of QR codes, and a small "Install Pilotage as an app" hint shows on the phone while it
is on plain http.

### Android (Chrome)

1. Scan code 1 (or tap **Download the certificate** on the phone). Chrome saves `pilotage-ca.crt` to Downloads.
   It can't install a certificate by itself; that's normal.
2. **Settings › Security & privacy › More security settings › Encryption & credentials › Install a certificate ›
   CA certificate** › *Install anyway*, then pick `pilotage-ca.crt`. Menu names vary by brand: search Settings for
   "CA certificate". The phone may ask for your screen lock.
3. Optional check: **Encryption & credentials › Trusted credentials › User › Pilotage local CA** shows the SHA-256
   fingerprint. It must match the one in Pilotage's Settings.
4. Scan code 2 (or tap **Open the secure address**): `https://<pc-address>:4748`. Chrome shows the padlock.
   If Pilotage says the phone isn't paired, pair it again with the https code (see below).
5. Chrome menu **⋮ › Install app** (older versions: *Add to Home screen*).

Each address (Wi-Fi, NetBird) is its own site for Chrome: install the app from the one you use most. Opening the
other one in the browser keeps working.

### iPhone / iPad (Safari)

1. Open the certificate link in Safari and tap **Allow**. iOS downloads it as a profile.
2. **Settings › General › VPN & Device Management** › the Pilotage profile › **Install**.
3. **Settings › General › About › Certificate Trust Settings** › turn on the Pilotage certificate.
4. Open the secure address in Safari, then **Share › Add to Home Screen**.

### No certificate: the Chrome flag fallback (Android)

If you'd rather not install a certificate, Chrome can be told to treat Pilotage's http addresses as secure:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` in Chrome on the phone.
2. Paste the http addresses, comma-separated, e.g. `http://192.168.1.20:4748,http://100.92.14.3:4748`
   (Settings shows yours with a copy button), set the flag to **Enabled** and relaunch Chrome.
3. Open the http address and use **⋮ › Install app**.

Trade-offs: the traffic stays unencrypted on Wi-Fi (NetBird traffic is still encrypted by WireGuard); Chrome trusts
anything that answers at those addresses as if it were secure; the flag applies to all of Chrome and can be reset by
Chrome updates (then the app falls back to a plain shortcut). The certificate is the better way.

### Questions

- **Will my paired phone have to pair again?** Usually not: the sign-in cookie is per address, not per protocol, so
  a phone paired over http is signed in over https too. If a future Chrome binds cookies to the scheme, it will show
  "not paired" on https: pair it once more with the https code.
- **The PC's address changed.** Pilotage checks the addresses every 10 minutes (and at start) and re-issues its server
  certificate when one isn't covered. Phones don't need to do anything: they trust the authority, not one
  certificate. The server certificate lasts 397 days and renews itself 30 days before it expires.
- **Offline.** The installed app opens an "offline: is your PC on?" page when it can't reach the PC, and retries by
  itself. Nothing from your sessions is stored on the phone: the service worker only caches the app's code files,
  never `/api` or `/auth`.

## Linux and macOS

There's no Windows forwarder outside WSL, so phone access is **off by default**. To turn it on, start Pilotage with:

```sh
PILOTAGE_LAN_BIND=0.0.0.0 pilotage restart     # or: PILOTAGE_LAN_BIND=0.0.0.0 node server/index.js
```

The phone listener then binds `0.0.0.0:4748` directly (`PILOTAGE_LAN_PORT` changes the port; you can also bind one
address, e.g. your VPN IP). To keep it on, export the variable in your shell profile (`~/.bashrc`, `~/.zshrc`) so
every start sees it. On macOS, run `pilotage install` again after setting it: the login item copies the `PILOTAGE_*`
variables of the shell it was installed from. Each connection is checked against an allow-list before anything is read:

| `PILOTAGE_LAN_ALLOW` | Allowed |
| --- | --- |
| unset / `lan,vpn` | the subnets this machine is on right now (from its network interfaces, /16 or smaller), NetBird/Tailscale (`100.64.0.0/10` and the VPN interface's own subnet), loopback |
| `vpn` | VPN only: the right choice for a laptop that joins other people's Wi-Fi |
| `vpn,192.168.1.0/24` | VPN plus an explicit subnet (keywords and IPv4 CIDRs can be mixed) |

There's no trusted-Wi-Fi check outside Windows: the `lan` rule allows whichever network you're on. Use `vpn` (plus your
home subnet as a CIDR) if the machine moves around. Also allow the port in your firewall, for example
`sudo ufw allow from 192.168.1.0/24 to any port 4748 proto tcp`; macOS asks the first time.

Everything else (pairing, HTTPS, Install app) works the same. The same mode works on WSL with *mirrored* networking;
the Windows forwarder is not started when `PILOTAGE_LAN_BIND` is set.

## Security notes

- **The certificate authority is name-constrained.** Its `nameConstraints` extension (marked critical) only permits
  private and VPN addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`) and local
  names (`localhost`, `.local`, `.lan`, `.home.arpa`). VPN names like `*.ts.net` or `*.netbird.cloud` are left out on
  purpose: those are public suffixes (Tailscale Funnel sites live on `ts.net`). Phones reach Pilotage by IP. A certificate it signs for
  `google.com` or a public IP fails verification (the tests check exactly that with `openssl verify`). It can't make
  sub-authorities (`pathlen:0`) and is limited to TLS servers (extended key usage `serverAuth`).
- **What a stolen CA key could still do.** It could impersonate HTTPS services *on private addresses or local names*
  for a device that trusts it: your router's admin page, a NAS. That's why the key never leaves `data/tls/` (folder `0700`, key files
  `0600`), is never served, logged or copied into backups, and why Pilotage never asks you to export it.
- **What's public.** `/pilotage-ca.crt` is the CA *certificate*: it's meant to be handed out, like any certificate.
  The keys (`ca.key`, `leaf.key`) are never served.
- **Rotate the certificate** (for example if the PC or its disk may have been compromised):
  1. `pilotage stop`, then delete `data/tls/`, then `pilotage start`. A new authority (new fingerprint) is created.
  2. On each phone, remove the old one: Android **Encryption & credentials › Trusted credentials › User › Pilotage
     local CA › Remove** (iPhone: delete the profile in VPN & Device Management), then install the new one as above.
  3. Re-install the app from the https address if it stops loading.
- **Remove it** the same way (step 2) if you stop using Pilotage on that phone.
- **No HSTS.** Pilotage never tells the browser "https only", so plain http keeps working as a fallback. The sign-in
  cookie is `HttpOnly` but not `Secure`, for the same reason. Prefer the https address or NetBird on Wi-Fi you don't
  fully control.
- **Rate limits and codes.** Failed pairing attempts are rate-limited per listener; pairing codes are single-use,
  10 minutes; device tokens are 256-bit and stored hashed.
