# CBE Tracker

A lifting tracker built on Pat Riley's **Career Best Effort** program.

- **Every session:** each lift's target is one small step past your best at your current weight.
- **Every 8-week season:** a lift earns a CBE when its average lift score is at least 1% above its best before.
- **Always:** a lift is flagged **Behind** when it falls below its own number two sessions in a row.

The app is plain HTML, CSS, and JavaScript with no build step, framework, or CDN. It works offline as an installable web app. All data stays on your phone in IndexedDB. This repo has no accounts, no backend, and no personal data; you enter your working weights on first launch.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app (UI) |
| `logic.js` | Every progression and CBE rule. Pure functions with no DOM access. |
| `routine.js` | Default routine: lifts, sets, rep ranges, and increments, with no weights |
| `store.js` | IndexedDB storage |
| `sw.js`, `manifest.webmanifest`, `*.png` | Offline cache, install metadata, and icons |
| `tests.js`, `tests.html` | Rule tests |

## Tests

Nothing needs to be installed.

- **In a browser:** open `tests.html` on the deployed site. The app links to it from **Settings → About → Run self-tests**, and it works offline.
- **With Node 18+:** run `node tests.js`.

## Deploy (GitHub Pages)

1. Create a **public** repo and upload every file in this folder to the root of `main`.
2. Go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, choose **main** and **/ (root)**, then click **Save**.
3. The site goes live at `https://<username>.github.io/<repo>/`.

All paths are relative, so the site works from any repo name.

## Shipping an update

Change `VERSION` in `sw.js` (for example `cbe-v1.0.1`) and upload the changed files. On the next launch, phones install the new version in the background and reload once. If you skip the version bump, phones keep serving the old cached files.

## Your data

- Data lives only on the device you use. Export a backup from **Settings → Backup** regularly, and keep the file somewhere safe such as iCloud Drive, Google Drive, or email.
- **iPhone:** add the app to your Home Screen *before* setting up. The Home Screen app and Safari keep separate storage. Removing the Home Screen icon deletes the app's data.
- **Android:** clearing Chrome's site data for this site deletes the app's data.
- To move to a new phone, import your latest backup from **Settings → Backup**.
