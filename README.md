# The 99 — Youth Follow-Up (PWA)

The same app you had, moved off Google Sites so it can be **installed on a phone
like a real app**. The design, wording and thresholds are unchanged. Google
Sheets is still the only place data lives.

---

## What changed, and why

| | Before | Now |
|---|---|---|
| Pages | Apps Script served the HTML | Static files on GitHub Pages |
| Data | Google Sheet | **Same Google Sheet** |
| Backend | `google.script.run` | Apps Script web app returning JSON |
| Who you are | `?servant=Name` in the URL | Google sign-in, matched to the Servants sheet |
| Installable | No | **Yes** |

**Why the pages had to move.** Apps Script renders your HTML inside a sandboxed
iframe on `googleusercontent.com`. A service worker and a web app manifest —
the two things that make a site installable — cannot be registered from there.
Any host that serves your own files works; GitHub Pages is free and fine.

---

## Files

```
index.html          A servant's flock: cards, reach-outs, notes, search
shepherds.html      All shepherds ranked by % In the Fold   (leaders only)
dashboard.html      Charts, grade leaderboard, banner        (leaders only)
assets/the99.css    The whole design system, one file
assets/the99.js     Sign-in, API calls, shared helpers
assets/icons/       App icons
code.gs             Paste this into the Apps Script editor
config.js           The two values you fill in (step 5)
manifest.webmanifest, sw.js, offline.html
oldFiles/           Your original implementation, untouched, for reference
```

---

## Setup

### 1. Prepare the sheet

Open the spreadsheet (`1v4CpILHr2ZuN2SeCfBh-HS6sCSDTRCsFJoJ1Y7X1p50`).

**On the `Servants` tab**, add a column with the header **`Role`**. Type
`Leader` in it for anyone who should see the dashboard, the shepherds list, and
every flock. Leave it blank for ordinary servants — they get their own flock
only. You can change this any time; no redeploy needed.

Make sure every servant's `Mail` cell holds the Google account they will
actually sign in with. **That column is the access list** — an account that
isn't on it cannot get in.

*Optional:* on the `FollowUp Logs` tab you may add headers `Note` and
`Logged_By`. If present they get filled in; if absent nothing breaks.

> Do **not** touch `Youths!Latest_Followup`. It is a formula
> (`MAX(FILTER('FollowUp Logs'…))`) and keeps recalculating itself. Nothing in
> the app writes to it.

### 2. Create the OAuth client ID

1. Go to <https://console.cloud.google.com/apis/credentials>, pick or create a project.
2. Configure the **OAuth consent screen**: External, fill in app name and your
   support email, then **Publish**. The app only reads name and email, which are
   non-sensitive scopes, so this needs no Google review. (If you leave it in
   *Testing*, only accounts you list as test users can sign in.)
3. **Create Credentials → OAuth client ID → Web application.**
4. Under **Authorized JavaScript origins** add the address the app will live at:
   - `https://YOUR-USERNAME.github.io`
   - and `http://localhost:8000` if you want to test locally.

   Origins only — no paths, no trailing slash. Leave *redirect URIs* empty.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 3. Deploy the backend

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with this repo's `code.gs`. Delete the old
   `index`, `shepherds` and `dashboard` HTML files — they are not used any more.
3. **Project Settings → Script properties → Add script property:**

   | Property | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | the Client ID from step 2 |
   | `LEADER_EMAILS` | *(optional)* extra leader emails, comma-separated |

4. **Show the manifest so the scopes are explicit.** Project Settings → tick
   *Show "appsscript.json" manifest file in editor*, then replace that file with
   this repo's `appsscript.json`. (Adjust `timeZone` if you are not in Cairo.)

5. **Run `setup` once.** Pick `setup` in the toolbar's function dropdown and
   click **Run**. Approve the permissions Google asks for, then read the
   Execution log — it checks the sheet, the tabs, the outbound call, your
   client ID, and who has `Role = Leader`, and tells you what is missing.

   This step is not optional. It is what grants the script permission to make
   the outbound call that verifies each sign-in. Skip it and every request fails
   with *"You do not have permission to call UrlFetchApp.fetch"*.

6. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**

7. Copy the **Web app URL** (ends in `/exec`).

> **Whenever you edit `code.gs` afterwards**, the live app does *not* change
> until you go to **Deploy → Manage deployments → ✏️ edit → Version: New
> version → Deploy**. Updating the existing deployment this way keeps the same
> URL, so you never have to touch `config.js` again. Creating a *new* deployment
> instead gives you a second URL with its own access setting — the usual cause
> of a sudden `401`.

> **"Anyone" does not mean the data is public.** It only lets the browser reach
> the endpoint. Every single request must carry a Google ID token that the
> script verifies with Google and then matches against the Servants sheet.

### 4. Publish the pages

1. Create a GitHub repository.
2. Upload everything in this folder **except** `oldFiles/`.
3. **Settings → Pages → Source: Deploy from a branch → `main` / root.**
4. Your address is `https://YOUR-USERNAME.github.io/REPO-NAME/`.

If the repo name is not your username's `.github.io`, the site sits in a
subfolder — that is fine, every path in this project is relative.

### 5. Fill in `config.js`

```js
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfy…/exec',
  GOOGLE_CLIENT_ID: '1234…apps.googleusercontent.com'
};
```

Commit it. That is the last step — open the site and sign in.

### 6. Tell everyone to install it

- **Android / Chrome:** an **Install** button appears in the header and raises
  the real install prompt.
- **iPhone / iPad:** the same **Install** button appears, but iOS has no
  programmatic install prompt — Apple does not implement `beforeinstallprompt`,
  and every browser on iOS is Safari's engine underneath, so Chrome and Firefox
  there behave identically. The button therefore opens a short panel showing
  the steps: Share → **Add to Home Screen** → Add.
- **Already installed?** The button hides itself, on both platforms.
- **Other browsers** (desktop Firefox, Firefox on Android) can still install
  from their own menus, but expose no event to detect it, so no button appears.

Your existing QR code points at the old Apps Script URL — regenerate it against
the new address. One QR now works for everybody, because the app knows who you
are from your sign-in instead of from the link.

---

## What I fixed along the way

1. **Anyone could open anyone's flock.** `?servant=` was never checked, and
   `updateNotes` ignored the servant argument entirely. Ordinary servants are
   now restricted to their own youths on both read and write; leaders are not.
2. **Names were injected unescaped** in the shepherds list and the grade
   leaderboard. Everything is escaped now.
3. **The celebration banner was hardcoded** to one name at 100%. It is computed
   from the live flock — a shepherd with no wandering and no lost sheep (and at
   least 3 youths), largest flock first. If nobody is at 100% it honours whoever
   is closest.
4. **`Latest_Followup` could read `#N/A`** for a youth with no logs, which
   happened to land in the right bucket by accident. The backend now resolves it
   from the log itself and returns a real date or a clean `null`.
5. **Search and sort** on your own flock, plus the summary chips now double as
   filters — tap *Lost Sheep* to see only them.

## Notes

- **Offline:** the app opens offline, but saving needs a connection — a strip
  appears when you drop off the network. Reach-outs are not queued.
- **Signing in lasts 30 days.** Google is asked once; the backend then issues
  its own session token, and the window slides forward whenever the app is used,
  so an active servant never signs in twice. Google ID tokens themselves last
  only an hour, and on iOS an installed app has its own cookie jar, so silent
  renewal through Google cannot work there — this is why the session is ours.
- **To sign everyone out at once**, delete the `SESSION_SECRET` script property.
  A new one is created on the next request and every old token stops verifying.
- **Removing a row from the `Servants` sheet revokes access within ~20 seconds**
  — the sheet is re-checked on every request, not just at sign-in, and that
  table is cached for 20 seconds.

## Speed

Apps Script takes a second or two to answer, and reading a sheet is the slowest
thing it does. Three things keep the app feeling quick:

- **The backend caches each sheet** (`Youths` and `FollowUp Logs` for 60s,
  `Servants` for 20s) in the script cache, chunked because a cache value is
  capped at 100KB. Writes invalidate the affected table straight away, so you
  never see your own change undone. Anything that writes by row number
  re-reads the sheet live — a cached row position would be wrong if a row had
  been inserted meanwhile.
- **The pages render from the last response first**, then refresh from the
  network and re-render. Revisiting a tab shows content in about 0.2s instead
  of waiting a second or two on every navigation.
- **The dashboard only receives the fields it uses.** It groups and counts; it
  never shows a phone number. Sending whole rows meant ~380KB a load, so it is
  projected down to about 110KB — and the contact details stay off the wire.

If you change anything in `assets/`, **bump `VERSION` in `sw.js`**, or phones
will keep serving the cached copy.
- **Thresholds** (In the Fold ≤ 30 days, Wandering 31–60, Lost Sheep over 60)
  are set once, in `code.gs`. The pages read them on sign-in.
- **After changing `sw.js`**, bump `VERSION` so phones pick up the new files.
