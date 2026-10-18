# MMBASAP

Send text, links and files from a locked-down laptop (no WhatsApp, only a browser) to **any phone number as an SMS**.

The page has two cards:
- **What to send:** type or paste text, drop in files.
- **Deliver to:** pick the channel and type the number.

Hit Send. Your own Android phone sends the SMS, so the recipient sees **your number** and can reply.

- Short text (up to 3 SMS) arrives as-is, ready to copy.
- Long text and files arrive as a short link, e.g. `https://your-mmbasap/s/Ab3xK9QpZz`. It opens a page with the full text and **Download** buttons. Links expire after 1 or 7 days, and a daily job deletes them.
- WhatsApp and Gmail show as "Soon". They will plug into the same channel interface (`lib/channels/`).

```
laptop browser ──► MMBASAP (Vercel) ──► api.sms-gate.app ──► your Android phone ──SMS──► recipient
      └── files PUT straight to private Vercel Blob storage (never through the API)
```

## Who installs what?

| Who | What they need |
| --- | --- |
| **Sender** (you, on any browser) | Nothing. Open your MMBASAP URL, enter the passcode, and send. |
| **Recipient** | Nothing. A normal SMS arrives from your number. File links open in their browser. |
| **Owner** (one time) | Install the SMS Gateway app on one Android phone with a SIM. It is the "SIM card" behind your MMBASAP. |

MMBASAP is meant to be **self-hosted, one copy per owner**. If you found this repo, deploy your own copy and connect your own phone; your messages go from your number.

## Why your phone and not an SMS API?

Commercial SMS in India must go through TRAI DLT. That needs:
- a registered business and a Rs 5,900 entity registration
- pre-approved message templates
- whitelisted links

You can't send free-form text that way. International routes (Twilio, about Rs 7 per SMS) arrive from random short codes. The [SMS Gateway for Android](https://sms-gate.app) app (open source, Apache-2.0) sends ordinary person-to-person SMS from your SIM instead. That costs nothing beyond your SMS pack.

## Run it on your Mac (dry run first)

```bash
npm start
```

This opens http://localhost:4190. With no `.env` there is no passcode, and SMS are **printed in the terminal** instead of sent, so you can try everything safely. Files are kept under `data/`.

To send real SMS locally, copy `.env.example` to `.env` and fill in `SMSGATE_USER` and `SMSGATE_PASS` (see below).

You don't need `npm install` locally. The two npm packages (`@neondatabase/serverless`, `@vercel/blob`) are only loaded when a database or Blob store is configured, which is on Vercel.

## Set up your phone (one time, about 5 minutes)

1. On your Android phone, download `app-release.apk` (the latest **stable** release) from [github.com/capcom6/android-sms-gateway/releases](https://github.com/capcom6/android-sms-gateway/releases) and install it.
2. **Android 15 or later:** Settings → Apps → SMS Gateway → ⋮ → **Allow restricted settings**. Then grant the **SMS** permission. Without the first step, the SMS permission stays greyed out.
3. Stop Android from killing it:
   - In the app's Settings, turn battery optimisation **off**.
   - In your phone's settings, allow **Autostart** and "No restrictions" for the app. The wording differs by brand: Xiaomi, Oppo, Vivo and OnePlus are strict.
4. In the app, open **Settings → Cloud Server** and switch it on. On the home screen, tap **Offline** so it turns **Online**.
5. Copy the **username** and **password** shown under Cloud Server into `SMSGATE_USER` and `SMSGATE_PASS`.
6. Optional settings:
   - On a dual-SIM phone, set `SMSGATE_SIM=1` or `2`.
   - If you ever add a second phone, pin one with `SMSGATE_DEVICE_ID`. To find the id, run `curl -u USER:PASS https://api.sms-gate.app/3rdparty/v1/devices`.

Test it by sending yourself a message from MMBASAP. Sending to the phone's **own** number usually works but depends on the carrier. If it doesn't arrive, send to another phone first.

Limits to know about:
- Android lets an app send about **30 SMS per minute**.
- Your plan's SMS pack is often **100 per day**. MMBASAP's own `DAILY_LIMIT` defaults to 50.
- If the phone is offline, messages wait up to an hour, then show as failed.

## Deploy to Vercel

1. Push this folder to a GitHub repo and import it in Vercel. Framework preset: **Other**; vercel.json already sets everything.
2. **Storage:**
   - **Neon:** Storage → Create → **Neon Postgres**, and connect it. This adds `DATABASE_URL`.
   - **Blob:** Storage → Create → **Blob** → access **Private**, and connect it. This adds `BLOB_READ_WRITE_TOKEN`.
3. **Environment variables (Production):**
   - `APP_PASSCODE`: 6 or more characters. This is what you type to unlock MMBASAP.
   - `JWT_SECRET`: generate with `openssl rand -base64 48`.
   - `SMSGATE_USER` and `SMSGATE_PASS`, from your phone.
   - `CRON_SECRET`: any random string. Vercel sends it to the daily cleanup job.
   - Optional: `PUBLIC_BASE_URL` (your custom domain), `DAILY_LIMIT`, `SMSGATE_SIM`, `SMSGATE_DEVICE_ID`.
4. Redeploy. Until every required setting is present, the site only shows the list of what's missing.
5. **Recommended:** add one **Firewall → Rate limit** rule (the free plan allows one) covering `/api/login`, `/api/send` and `/s/`, for example 30 requests per minute per IP.
6. **Optional:** a custom domain. A `mmbasap.yourname.in` link in an SMS looks more trustworthy, and carriers are less likely to flag it, than `*.vercel.app`.

### First checks after deploying
- **Open the site from the work laptop.** Some company web filters block `*.vercel.app` or newly registered domains. If it's blocked, try a custom domain.
- **Attach a small PDF.** The upload goes straight from your browser to Vercel Blob using a presigned URL. MMBASAP sends the same headers as Vercel's own browser uploader, but this is the one part that can't be tested locally.
  - If the upload fails with a CORS or 403 error, note the browser console message.
  - The fix is then to swap `blobFiles` in `lib/files.js` for an S3-compatible store (Neon Object Storage or Cloudflare R2). The browser-side code doesn't change.

## Development

```bash
npm test
```

This uses node:test, with no installs needed. It covers:
- number formats and SMS part counting
- the gateway adapter against a stubbed API
- every route end to end, including uploads, downloads, expiry, daily limit, login lockout and cross-site refusal
- escaping on the share page
- the deployment's fail-closed setup check

| Path | What it is |
| --- | --- |
| `public/` | The page: vanilla JS, no build step. `js/sms.js` is shared with the server, so the preview matches what's sent. |
| `lib/app.js` | All routes. |
| `lib/channels/` | `sms-gate.js` (your phone), `console.js` (dry run), `index.js` (the registry; WhatsApp and Gmail go here later). |
| `lib/shares.js` | Send history and share pages: JSON file locally, Neon on Vercel. |
| `lib/files.js` | Attachments: local disk with signed links locally, private Vercel Blob on Vercel. |
| `lib/share-page.js` | The page recipients open. |
| `api/index.js` | Vercel entry; fails closed until configured. |

## Roadmap
- **Gmail/email:** via Resend (real attachments; free tier of 3,000 a month).
- **WhatsApp:** via Meta's Cloud API with a second number. It's free inside the 24-hour window, for up to 1,000 messages a month.
- **Inbound:** forward SMS that arrive on your phone (gateway `sms:received` webhook), WhatsApp or email into another channel.
- **Push to your own phone:** ntfy or Web Push, with no SMS limits.
- **Flutter Android app:** a share-target app that calls the same API.
