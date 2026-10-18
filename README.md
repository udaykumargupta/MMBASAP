# MMBASAP

Send text, links, photos, videos and files from a locked-down laptop (no WhatsApp, only a browser) to **any phone number on WhatsApp or SMS**. Messages go out **from your own number**, it's **free**, and nobody installs anything.

The page has two cards:
- **What to send:** type or paste text, drop in files.
- **Deliver to:** pick WhatsApp or SMS and type their number.

## How it works: pair your phone

```
One time:  the laptop shows a QR code ─► scan it with your phone's camera ─► the phone is paired
Each time: type on the laptop ─► it pops up on your phone ─► tap "Open WhatsApp chat" / "Open Messages" ─► Send
```

- **Your own phone sends it**, through the real WhatsApp or Messages app, so the recipient gets a completely normal message from you.
- **No app and no account.** The phone just opens a web page (`/phone`). You can add it to your home screen.
- **Files:**
  - On WhatsApp, the phone gets the actual file (photos, videos, PDFs, audio) and shares it into the chat. Office files and zips on Android go as a download link instead.
  - On SMS, files always go as a download link (SMS can't carry files).
- **Message text is end-to-end encrypted.** The key lives only in the QR code (the part after `#`, which browsers never send to servers). The server stores only scrambled text; it expires after a day and is deleted by the next daily cleanup.
- **Files are stored privately but not end-to-end encrypted.** They go to a private store in a random folder. The daily cleanup deletes them after their link expires (1 or 7 days, never more than 8 after upload). Anyone who has the link can download them, a few times a day at most, so don't send anything you wouldn't email.
- **One tap on the phone is required.** Phones don't let any website send WhatsApp or SMS on its own. That tap is also what keeps this free, legal and safe for your account.

Why not "link your WhatsApp/Messages to the website"? It was researched in October 2026:
- **Google Messages:** Google switched off QR pairing in 2026, and the only remaining method would mean handing over full Google login cookies.
- **WhatsApp:** unofficial linking breaks WhatsApp's terms. Accounts are being banned for messaging new numbers, and it would give the server read access to everyone's chats.
- **iPhone:** has no linking option at all.

### Owner extra: Auto SMS
The owner can also send SMS **without the tap**. Your own Android phone sends them in the background through [SMS Gateway for Android](https://sms-gate.app). This is optional and locked behind the owner passcode, because it uses the owner's number and SMS pack.

## Who installs what?

| Who | What they need |
| --- | --- |
| **Anyone sending** (any browser) | Nothing. Open the MMBASAP URL. |
| **Their phone** | Nothing. Scan the QR once with the camera. Works on Android and iPhone. |
| **Recipient** | Nothing. A normal WhatsApp message or SMS arrives. |
| **Owner, only for Auto SMS** | The SMS Gateway app on one Android phone (see below). |

## Run it on your Mac

```bash
npm start
```

This opens http://localhost:4190.
- Data and files are kept under `data/`.
- Auto SMS is a **dry run** until you add the gateway login: messages are printed in the terminal instead of sent.

A phone can only pair with an **https** address, because encryption needs a secure page. So test pairing on your Vercel deployment. On the Mac itself you can open `/phone` in a second browser tab.

You don't need `npm install` locally. The two npm packages (`@neondatabase/serverless`, `@vercel/blob`) only load on Vercel.

## Deploy to Vercel

1. Import the GitHub repo in Vercel. Framework preset: **Other**; `vercel.json` sets everything else.
2. **Storage tab (required):**
   - **Neon** (Postgres): connect it through the Storage tab, or create it at neon.tech and paste its connection string into an environment variable named `DATABASE_URL`.
     - **Keep the database and the functions in the same region**, because every request makes several database queries. `vercel.json` runs the functions in `cle1` (Cleveland), next to Neon's **AWS US East 2 (Ohio)**.
     - If your Neon database is elsewhere, change `regions` in `vercel.json` to match, for example `sin1` for Singapore or `iad1` for US East 1.
   - **Blob:** access **Private**, then **Connect** it to the project.
     - Vercel connects it by OIDC and adds `BLOB_STORE_ID`; MMBASAP picks up Vercel's per-request token by itself.
     - A `BLOB_READ_WRITE_TOKEN` also works if you prefer one.
3. **Settings → Environment Variables (recommended):**
   - `CRON_SECRET`: any random string. With it, only Vercel's daily job can run the cleanup. Without it, cleanup still runs, but anyone can trigger it; it only deletes what has expired.
   - **Free-tier limits.** They aim to keep a public MMBASAP inside Vercel Blob's free tier (1 GB stored, 10 GB downloaded a month):
     - `PUBLIC_STORAGE_MB` (default `600`): the most file storage everyone except the owner can use at once.
       - Each pairing and each network can use up to 200 MB of it.
       - Files nobody sends are cleared after 20 minutes.
       - `0` turns public uploads off.
     - `PUBLIC_DAILY_DOWNLOAD_MB` (default `300`): download links handed out per day, counted by file size.
       - The owner's Auto SMS links have a separate allowance of the same size, so the public can't use them up.
       - Each file can be downloaded at most 5 times a day.
       - This counts download links, not bytes actually moved, so also set a **usage alert** in Vercel (Settings → Billing).
4. **Redeploy.** Pair-your-phone now works for everyone.
5. **Optional, the owner's Auto SMS.** Add these, then redeploy:
   - `APP_PASSCODE`: 6 or more characters. You unlock Auto SMS with it via the **Owner** button.
   - `JWT_SECRET`: generate with `openssl rand -base64 48`.
   - `SMSGATE_USER` and `SMSGATE_PASS`, from your phone (see below).
   - Optional: `SMSGATE_SIM` (`1` or `2`), `DAILY_LIMIT` (default 50 SMS a day).
6. **Recommended:** add one **Firewall → Rate limit** rule covering only the costly routes, for example 60 requests per minute per IP:
   - `/api/upload-url`
   - `/api/links`
   - `/s/*/file/*`

   Leave the phone's and laptop's status checks alone: a paired laptop and phone together check about 60 times a minute, and an office shares one IP.

A random secret for any of these, copied to your clipboard without showing it:
```bash
openssl rand -base64 48 | tr -d '\n' | pbcopy
```

### First checks after deploying
- **Open the site on the work laptop.** Some company filters block `*.vercel.app`; a custom domain can help.
- **Pair your phone:** scan the QR code and send yourself a text. The laptop should show "On your phone ✓".
- **Attach a small video:**
  - Laptop side: the upload goes straight from the browser to Vercel Blob, and can't be bigger than the size it declared.
  - Phone side: you should see **Share file to WhatsApp**. If you see a download link instead, your phone's browser couldn't fetch the file directly; the link still works.

## Set up the phone for Auto SMS (owner only, about 5 minutes)

1. On your Android phone, download `app-release.apk` (latest **stable** release) from [github.com/capcom6/android-sms-gateway/releases](https://github.com/capcom6/android-sms-gateway/releases) and install it. Make sure it is **SMS Gateway** by capcom6, not a look-alike.
2. **Android 13 and later:** Settings → Apps → SMS Gateway → ⋮ → **Allow restricted settings**, then grant **SMS**.
3. Turn battery optimisation **off** for the app, and allow **Autostart** if your phone has it.
4. In the app, open **Settings → Cloud server** and switch it on. On the home screen, tap **Offline** so it turns **Online**.
5. Copy the **Username** and **Password** shown there into `SMSGATE_USER` and `SMSGATE_PASS`. Treat them like a password: anyone with both could send SMS from your number.

Limits:
- Android allows about 30 SMS per minute.
- Many plans include about 100 SMS a day.
- If the phone is offline, messages wait up to an hour, then fail.

## Development

```bash
npm test
```

This uses node:test with no installs. It covers:
- encryption and pairing links
- the QR code
- number formats and SMS part counting
- the gateway adapter
- every route end to end: rooms, uploads, budgets, links, expiry and cleanup, Auto SMS, sign-in lockout, cross-site refusal
- the deployment's fail-closed setup

| Path | What it is |
| --- | --- |
| `public/index.html`, `js/app.js` | Laptop page: the two cards, pairing QR, status. |
| `public/phone.html`, `js/phone.js` | Phone page: receives messages, opens WhatsApp/Messages, shares files. |
| `public/js/pair.js` | Pairing and AES-GCM encryption (Web Crypto), wa.me and sms: links. Shared with tests. |
| `public/js/sms.js` | Number formats and SMS part counting. Shared with the server. |
| `public/vendor/qrcode.js` | QR encoder (MIT, Kazuhiko Arase), vendored so no CDN is needed. |
| `lib/app.js` | All routes. |
| `lib/rooms.js` | Rooms, encrypted messages, uploads, daily budget (JSON locally, Neon on Vercel). |
| `lib/shares.js` | Download-link pages and Auto SMS history. |
| `lib/files.js` | Attachments: local disk with signed links, or private Vercel Blob. |
| `lib/channels/` | Owner's SMS gateway (`sms-gate.js`) and dry run (`console.js`). |
| `api/index.js` | Vercel entry; fails closed until Neon and Blob are connected. |

## Roadmap
- **Gmail/email:** via Resend (real attachments).
- **Phone notifications:** Web Push, so new messages ring the phone even when the page is closed.
- **Flutter Android app:** a share-target app.
