# Push notifications

**日本語の要約:** 生徒は「アカウント → 通知」で端末ごとに通知をオンにできます。ポイントの付与・減算・訂正・取消と、景品交換の完了・取消が通知されます(種類ごとにオフにできます)。追加の設定は不要です。iPhone/iPad では、先にアプリを「ホーム画面に追加」して、そこから開く必要があります。通知がオフ・非対応・拒否でもアプリは今までどおり使えます。

## What students get

| Event | Setting | Message (example) |
|---|---|---|
| Points awarded (teacher award, administrator adjustment) | Point changes | *Points awarded* — `+10 pts · Passed the unit 3 quiz · Balance 35` |
| Points deducted | Point changes | *Points deducted* |
| An award is cancelled / a deduction is corrected | Point changes | *Award cancelled* / *Points corrected* |
| A reward redemption is completed | Reward requests | *Reward redemption completed* — `<reward name>` |
| A redemption is cancelled and the points returned | Reward requests | *Reward request cancelled* |

A student's own redemption request does not notify them. Tapping a notification opens the app at the history or rewards page.

Where it lives in the app: **Account → Notifications** (students only). The card shows what applies to the device: *Turn on notifications*, two switches, *Send a test notification*, *Turn off notifications*. Notifications are per device; the two switches are per person.

## Setup

None. The first deploy that contains this feature:

1. adds the tables (migration `0002_push`, applied automatically),
2. starts a one-minute schedule (`triggers.crons` in `wrangler.jsonc`, string `* * * * *`),
3. generates the server's Web Push identity (a VAPID key pair) on first use and keeps it in D1.

Optional overrides (Workers → Settings → Variables and Secrets):

| Name | Meaning |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Use your own key pair (base64url) instead of the generated one. Set both or neither. Generate with `node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>{const j=await crypto.subtle.exportKey('jwk',k.privateKey);console.log(j.d, Buffer.from(await crypto.subtle.exportKey('raw',k.publicKey)).toString('base64url'))})"` (first line private, second public). |
| `VAPID_SUBJECT` | Contact sent to push services, `mailto:you@school.example` or an `https:` URL. Default: this site's address. |

**Changing the key pair invalidates every registered device** (browsers tie a subscription to the key). Students then turn notifications on again.

### iPhone and iPad

Safari only supports Web Push for apps added to the Home Screen (iOS/iPadOS 16.4 or newer): *Share → Add to Home Screen*, then open the app from the new icon. In a normal Safari tab the card explains this instead of offering the button.

## How it works

- **Events come from data that already exists.** The point ledger (append-only) and the activity log are read in order; a cursor per table (`app_settings`) remembers the position, so each event is announced exactly once and no existing route had to change. Rows from before the upgrade are never announced.
- Each event becomes one row per registered device in `push_outbox`. Messages are sent right after the request that caused them (`waitUntil`, the response is not delayed) and, as a safety net, by the minute job.
- A message is encrypted for the device (RFC 8291, `aes128gcm`) and authenticated with VAPID (RFC 8292); only the push service and the device see it, and the push service cannot read it. Implemented with Web Crypto in `src/webpush.ts` and tested against the RFC's example message.
- Delivery results: `201` → done. `404`/`410` → the device is gone and is deleted. Anything else (`429`, `5xx`, timeouts) → retried after 1, 5 and 15 minutes, then dropped. Messages older than 24 h are removed daily.
- **Limits:** a Worker invocation may make a limited number of outgoing requests (50 on the free plan). A request sends at most 12 messages (`IN_REQUEST_MAX`) and the minute job at most 40 (`CRON_MAX`), the rest waits for the next minute. A bulk award to a whole class is therefore fully delivered within about a minute. Raise the constants in `src/push.ts` on a paid plan if needed.

## Privacy and safety

- Nothing is stored about a notification except what is needed to send it; the text is made when it is sent.
- Notifications can show on a lock screen, so they contain only points, the reason a teacher typed (shortened) and the reward name.
- **Shared devices:** signing out removes the device from the account. If a session ended without signing out, the next student's home page drops a subscription that is not theirs. A device that someone else registers moves to that person.
- Only addresses of known browser push services (Google FCM, Mozilla, Apple, Windows) are accepted as device endpoints, so the feature cannot be used to make the Worker contact arbitrary sites.
- At most 10 devices per person; 30 registrations per hour; 5 test notifications per 10 minutes.
- Accounts that are deactivated or anonymized receive nothing; anonymized accounts lose their devices in the daily job.
- Devices and preferences are **not** part of the backups (they are tied to a browser and a key pair). After a restore students turn notifications on again.

## Troubleshooting

1. **Account → Notifications → Send a test notification.** If it arrives, delivery works; if it fails, see below.
2. *"Notifications are blocked"*: the browser setting for this site is *Block*. Allow it and reload.
3. Nothing arrives although the test said "sent": check the Worker logs for lines starting with `push: delivery to … failed`. `HTTP 401/403` usually means the key pair changed or the site address in `VAPID_SUBJECT` is invalid; `HTTP 429/5xx` are temporary.
4. After changing VAPID keys, or after a long time offline, a device may be gone: turn notifications off and on again.
5. Android battery savers and iOS Focus modes can delay or hide notifications; this is outside the app.

## Adding a new kind of notification

1. In `src/push.ts`: add an `INSERT INTO push_outbox … SELECT` for the new event next to `TX_EVENTS_SQL` (or extend one), add a `kind` case in `renderMessage` with English and Japanese text, and add a preference column if it needs its own switch (new migration).
2. Add the strings to `public/i18n-push.js` if the UI changes, and a test to `test/push.test.ts`.

## Tests

`npm test` covers: the cryptography against the RFC example (`webpush.test.ts`), the server pipeline end to end with a fake push service (`push.test.ts`), the browser-side card and subscription handling (`push-frontend.test.ts`), and the service worker (`sw-push.test.ts`).
