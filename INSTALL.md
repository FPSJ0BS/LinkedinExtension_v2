# Installing Profile Vault React on another device

This folder is the installer. It contains:

```
INSTALL.md    this file
extension/    the extension itself — this is the folder you select in step 5
```

Everything runs locally. There is no account, no server, no sign-up, and the install
itself does not need an internet connection.

## Why this is a .zip and not a setup.exe

Chrome will not install an extension from a file. Dragging a `.crx` onto the browser has
been blocked outside the Chrome Web Store for years, and a desktop installer cannot get
around that — it is the browser that declines, not Windows. The supported way to install
an extension distributed outside the store is **Load unpacked**, which takes a folder.

So the installer is that folder, packed for transport. Nothing needs administrator
rights and nothing is written outside the browser.

## What you need

A desktop Chromium browser: Google Chrome, Microsoft Edge, Brave, Vivaldi or Opera.
The steps are identical in all of them; only the address in step 3 changes.

## Install

1. **Copy the `.zip` to the device and unzip it.**
   Windows: right-click → *Extract All*. macOS: double-click.
   Do not try to load the extension from inside the zip — Chrome needs a real folder.

2. **Put the unzipped folder somewhere permanent, and leave it there.**
   Documents is a good place. Downloads is not.
   ⚠ Chrome does not copy the extension anywhere. It loads it from this folder every
   time it starts, so if the folder is deleted, moved or renamed later, the extension
   stops working. Treat it as installed software, not as a downloaded file.
   A folder on a USB stick or a network drive will break every time it is unplugged.

3. **Open the extensions page.** Type the address in yourself — it is not a website:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`

4. **Turn on Developer mode.** Chrome and Brave put the switch at the top right of that
   page; Edge puts it at the bottom left. This only allows loading from a folder; it
   does not change how the browser handles anything else.

5. **Click "Load unpacked" and select the `extension` folder.**
   That is the folder containing `manifest.json` — not the folder above it. A card for
   *Profile Vault React* appears, showing the same version number as the folder name.

6. **Pin it to the toolbar.** Click the puzzle-piece icon next to the address bar, then
   the pin next to Profile Vault React. Its popup is where every command lives.

7. **Reload any LinkedIn tab you already had open.** The extension reads a page by being
   injected into it when it loads, so a tab opened before the install has nothing in it.

## What the browser will ask for

Chrome summarises the extension's host access as *"Read and change your data on"*:

| Access | What it is for |
|---|---|
| `linkedin.com` | The profile, connections and hiring pages it reads, after you press a button |
| `media.licdn.com`, `static.licdn.com` | LinkedIn serves applicant resume files from its own CDN, which is a different address from the page showing them. Read-only fetches of files your account can already open |
| Storage | Your saved profiles, the import queue, and your settings |
| Downloads | Saving CSV exports and applicant resumes |
| Alarms | A one-minute heartbeat, so an import interrupted by Chrome suspending the extension picks itself back up |
| Scripting / active tab | Injecting the readers into the LinkedIn tab you are on |

It has no access to any other site, never handles a password, and sends nothing anywhere.

## Your saved data does **not** travel with the installer

The installer carries the extension, not its contents. Browser storage belongs to the
device and the browser profile, so a fresh install starts with an empty vault. That is
also true of a second browser on the same machine.

To move saved profiles across:

1. On the old device: open **Saved Profiles** and click **Export all CSV**.
2. Copy the `.csv` across.
3. On the new device: open **Saved Profiles** and click **Import CSV**.

Collected **applicants** are a separate store, and the transfer only goes one way:
**Download CSV** on the Job Applicants page exports them for a spreadsheet, but there is
no applicant CSV import, so applicants stay on the device that collected them.

## Updating to a newer version

⚠ Keep the folder in the same place. Chrome works out an unpacked extension's identity
from the folder's full path, and its storage is tied to that identity — so a folder moved
or renamed comes back as a *different* extension with an empty vault. (The old data is
not deleted; it simply belongs to the old path.)

1. Unzip the new version.
2. Replace the **contents** of your existing `extension` folder with the contents of the
   new one, keeping the folder itself exactly where it is.
3. On `chrome://extensions`, press the **reload** arrow on the Profile Vault React card.

Everything you have saved is preserved.

## Checking the download arrived intact (optional)

The `.zip` ships with a `.sha256` file next to it. Compare the two:

- Windows PowerShell: `Get-FileHash profile-vault-react-<version>.zip -Algorithm SHA256`
- macOS / Linux: `shasum -a 256 profile-vault-react-<version>.zip`

The hash should match the one in the `.sha256` file. This confirms the file transferred
without corruption; it is not a code signature and does not prove who built it.

## Uninstalling

On `chrome://extensions`, click **Remove** on the card. ⚠ That deletes everything the
extension has saved on that device — export first if you want to keep it. Then delete the
folder you unzipped.

## If something goes wrong

| What you see | What it means |
|---|---|
| *"Manifest file is missing or unreadable"* | The wrong folder was selected. Pick `extension` — the one that directly contains `manifest.json`. |
| The extension vanished after restarting the browser | The folder was moved, renamed, deleted, or is on a drive that was not connected. Put it back and press **Load unpacked** again. |
| *"Service worker (inactive)"* on the card | Normal. Manifest V3 lets the background worker sleep; it wakes when it is needed. |
| A *"Disable developer mode extensions"* bubble at startup | Normal for any unpacked extension. Dismissing it leaves the extension enabled. |
| The popup opens but nothing happens on LinkedIn | Reload the LinkedIn tab. Tabs opened before the install, or before a reload of the extension, have no reader in them. |
| An empty vault after moving the folder | See *Updating* above — the data belongs to the old folder path. Move the folder back to recover it. |
