# Central Drive upload — setup (≈10 minutes, no server)

Sessions auto-upload to **one Google Drive folder** after you tap **Stop**
(with an on-device **Upload** retry button if a device is offline). The Drive
access lives inside a Google Apps Script web app, so no secret is shipped in the
public site. Uploads are **idempotent by filename**, so retries never duplicate.

## 1. Make the destination folder
1. In Google Drive, create a folder, e.g. **Muse Sessions**.
2. Open it. The URL looks like `https://drive.google.com/drive/folders/`**`1AbCdEf...`** — copy that id (the part after `folders/`).

## 2. Create the Apps Script web app
1. Go to <https://script.google.com> → **New project**.
2. Delete the default code, paste the contents of **`cloud/Code.gs`**.
3. At the top of the script set:
   - `FOLDER_ID` = the folder id from step 1.
   - `SHARED_TOKEN` = a long random string (e.g. from a password generator).
4. **Deploy → New deployment → ⚙ → Web app.**
   - **Description:** anything.
   - **Execute as:** **Me** (your account — this is what grants Drive access).
   - **Who has access:** **Anyone**.
   - Click **Deploy**, then **Authorize access** and approve the Drive permission
     (you'll see an "unverified app" screen for your own script — choose
     *Advanced → Go to project → Allow*).
5. Copy the **Web app URL** — it ends in **`/exec`**.

Sanity check: open that `/exec` URL in a browser. You should see
`{"status":"ready",...}`.

## 3. Point the app at it (git workflow — secrets stay out of the repo)
The endpoint + token are injected at **deploy time** from GitHub Secrets, so they
are never committed. In the repo:

1. **Settings → Secrets and variables → Actions → New repository secret** (twice):
   - `CLOUD_ENDPOINT` = your Apps Script `/exec` URL
   - `CLOUD_TOKEN` = the same value as `SHARED_TOKEN`
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. `git push` to `main`. The workflow (`.github/workflows/deploy.yml`) writes
   `js/config.js` from those secrets, stamps the service-worker cache with the
   commit SHA (automatic cache-busting — no manual bump), and publishes.

For **local** testing, copy the template once and fill in your values:
```
cp muse-recorder/js/config.example.js muse-recorder/js/config.js
```
`js/config.js` is gitignored, so your local copy is never committed.

> **Reminder:** `.gitignore`/Secrets keep the token out of your *repository*, but
> the deployed site still serves `config.js` publicly — anyone can read the token
> in the browser. That is normal for a static site; the real protection is the
> Apps Script (idempotent, writes only to your folder). If the token ever lands in
> a public commit, rotate it: change `SHARED_TOKEN` here **and** the `CLOUD_TOKEN`
> secret, then redeploy both.

## 4. Use it
Record → **Stop**. The session saves locally, then uploads; the **Saved sessions**
screen shows **☁ uploaded** / **☁ not uploaded** / **☁ upload failed** and an
**Upload** button to retry. Each `.xdf` lands in your folder, plus a small
`*.meta.json` sidecar (subject, duration, dropped-sample counts, device info).

## Notes & limits
- **Token is not truly secret** — it ships in the public JS, so it only deters
  casual abuse. For a single-user research collector that's the normal trade-off.
  To rotate it, change `SHARED_TOKEN` in the script **and** `token` in config, then
  redeploy both. To lock it down further, set *Who has access: Anyone with Google
  account* — but then browsers can't POST without an OAuth flow (more work).
- **Size:** the script caps a session at ~45 MB (base64 inflates ~33%). Typical
  sessions are a few MB; an hour of all-streams EEG is still well under the cap.
- **Updating the script:** after editing `Code.gs`, **Deploy → Manage deployments
  → edit → Version: New version → Deploy** (the `/exec` URL stays the same).
- **Privacy:** data goes to *your* Drive folder only. Nothing is stored on GitHub.
