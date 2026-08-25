# Setting up Profile Vault React

Profile Vault React is a local-first Chrome **Manifest V3** extension. It reads LinkedIn pages you
are already looking at, keeps what it finds in the browser's own database, and exports CSV. There is
no account, no server, no sign-up and no API key, so "setting it up" means getting a folder onto the
machine and pointing the browser at it — nothing more.

There are two ways to do that. Pick by what the device is for:

| The device is for | Route |
|---|---|
| **Using** the extension — no code, no tools | **[Route A](#route-a--install-a-packaged-build)** — a packaged `.zip`, ~2 minutes |
| **Building, changing or testing** it | **[Route B](#route-b--set-up-from-this-repository)** — from this repository, ~5 minutes |

Both end at the same place: `chrome://extensions` → **Developer mode** → **Load unpacked** → a
folder. Route B just builds that folder instead of unzipping it.

---

## Route A — install a packaged build

Someone with the source runs `npm run package`, which writes
`releases/profile-vault-react-<version>.zip`. That archive is the installer: it carries the built
extension and its own instructions.

1. Copy the `.zip` to the device and unzip it.
2. Open [`INSTALL.md`](INSTALL.md) — a copy is inside the archive, beside the `extension` folder.
3. Follow it.

[INSTALL.md](INSTALL.md) is the complete end-user document: the steps, why the folder must stay
where you put it, how to update in place, how to move saved profiles between devices, and what each
thing that can go wrong actually means. It is not repeated here.

> **Why a `.zip` and not a `setup.exe`.** Chrome refuses to install an extension from a file —
> dragging a `.crx` in has been blocked outside the Web Store since Chrome 33, and a desktop
> installer cannot get around that, because it is the browser that declines, not Windows. **Load
> unpacked** takes a folder, so the installer is that folder, packed for transport.

---

## Route B — set up from this repository

### 1. What you need

| | | Check it with |
|---|---|---|
| **Node.js 22 LTS or newer** | Runs the build, the tests and the checks | `node --version` |
| **npm 10 or newer** | Ships with Node | `npm --version` |
| **git** | To clone; a downloaded ZIP of the source works too | `git --version` |
| **A Chromium browser** | Chrome, Edge, Brave, Vivaldi or Opera — desktop, not mobile | — |

This setup is verified on **Node 24.16.0** with **npm 11.13.0**.

Node 22 is the floor because `npm test` hands a glob (`tests/*.test.js`) straight to `node --test`,
which only expands globs itself from Node 21 onward — on Windows the shell will not do it for you,
so an older Node reports that it found no tests rather than that it is too old.

**Nothing is installed globally.** There is no bundler, no CLI to install, no toolchain beyond Node;
TypeScript comes from the project's own `devDependencies`. Internet access is needed once, for
`npm install`. Everything after that — building, testing, packaging — works offline.

### 2. Get the code and install dependencies

```bash
git clone <repository-url>
cd profile-vault-react
npm install
```

`npm install` fetches exactly two things that matter: **typescript 5.8.3** (the compiler) and
**chokidar** (file watching for the Project Time Machine).

`react` and `react-dom` are listed as dependencies, but nothing bundles them — the runtime Chrome
actually loads is checked into [`extension/vendor/`](../extension/vendor/) as
**React 16.0.0 / ReactDOM 16.0.1**. That copy is the real one. If `node_modules` and `vendor/` ever
disagree, `vendor/` wins, because it is what ships.

### 3. Build and check

```bash
npm run check
```

That is the whole setup step. It runs five stages, and each proves something different:

| Stage | Command | What it proves |
|---|---|---|
| 1 | `npm run typecheck` | `tsc --noEmit` over `src/**` — the TypeScript is sound |
| 2 | `npm run build` | `dist/` is produced: compiled `src/`, the pages, the styles, the content scripts, the icons, the vendored React |
| 3 | `npm test` | The pure cores behave — **531 tests** at the time of writing |
| 4 | `npm run docs:check` | Every local Markdown link in the docs resolves |
| 5 | `npm run validate` | `dist/` is loadable: 31 required files present, all four pages load React locally, the service worker's relative imports resolve, no page pulls a script from a remote origin |

A clean run ends with:

```
Checked local links in 18 Markdown files.
Validated 31 build files, 4 React entry points, and service-worker imports.
```

Two things about the build worth knowing before they surprise you:

> ⚠ **`npm run build` deletes `dist/` before it compiles.** A build that fails partway leaves no
> extension at all, not the previous one. `npm run check` typechecks first for exactly this reason —
> prefer it over a bare `npm run build`.

> ⚠ **Run it through npm, never as `node scripts/build.mjs`.** The build shells out to `tsc` and
> finds it on `PATH`, where npm puts `node_modules/.bin` only for the duration of an npm script.
> Run directly, it deletes `dist/` and *then* fails with "tsc is not recognized".

### 4. Load it into the browser

1. Open the extensions page. Type the address yourself — it is not a website:
   `chrome://extensions` · `edge://extensions` · `brave://extensions`
2. Turn on **Developer mode** (top right in Chrome and Brave; bottom left in Edge).
3. Remove or disable any older Profile Vault, so two copies do not both answer the popup.
4. Click **Load unpacked**.
5. Select the project's **`dist`** folder.
6. Pin it: the puzzle-piece icon beside the address bar → the pin next to *Profile Vault React*.
   The popup is where every command lives.
7. **Reload any LinkedIn tab that was already open.** The readers are injected when a page loads, so
   a tab that predates the install has nothing in it.

> ⚠ **Select `dist`, not `extension`.** [`extension/`](../extension/) contains a `manifest.json`, so
> the folder picker will happily accept it — but it has no `src/`, and the manifest declares
> `src/background.js` and the content-script cores, which exist only after a build. Chrome loads it
> and then reports a missing service worker. `dist/` is the only folder Chrome should ever be given.

### 5. Confirm the setup is real

| Check | Expected |
|---|---|
| The card on the extensions page | **Profile Vault React 3.9.2** |
| The build ID in the popup | `2026-08-25-react-v3.9.2` |
| `dist/build-meta.json` | The same version and build ID |
| The popup's commands | All three surfaces offered by name — profile, connections, applicants |
| The pages open | Saved Profiles, Connections Collector, Job Applicants |
| *"Service worker (inactive)"* on the card | Normal. Manifest V3 lets the worker sleep; it wakes when needed |

**The build ID is not decoration.** The popup, the service worker and the three content scripts each
carry it, and a content script whose ID does not match the worker's is refused and re-injected. So if
the number in the popup is not the one in `dist/build-meta.json`, the browser is running a stale
load — press the **reload** arrow on the card, then reload the LinkedIn tab.

### 6. What the browser is being asked for

Chrome summarises this as *"Read and change your data on"* a handful of addresses. In full:

| Permission | What it is for |
|---|---|
| `linkedin.com` | The profile, connections and hiring pages it reads — after you press a button |
| `media.licdn.com`, `static.licdn.com` | LinkedIn serves applicant resumes from its own CDN, a different address from the page showing them. Read-only fetches of files the account can already open |
| `storage` | Settings and the service worker's own small state — the last hiring page, auto-run records, the installed build ID. Your saved profiles and applicants are *not* here; they are in IndexedDB, which needs no permission |
| `downloads` | Saving CSV exports and applicant resumes |
| `alarms` | A one-minute heartbeat, so an import interrupted by Chrome suspending the worker resumes |
| `scripting`, `activeTab` | Injecting the readers into the LinkedIn tab you are on |

The readers only run on four kinds of page: `linkedin.com/in/*`, `/hiring/*`, `/talent/*` and
`/mynetwork/…/connections/*`. There is no access to any other site.

**The extension never handles a credential** — no password input, no `document.cookie`, no
`chrome.cookies`. Signing in only navigates to LinkedIn's own login page, and login state is inferred
from the page.

---

## After you change code

| You changed | Do this |
|---|---|
| Anything in `src/**` or a content script | `npm run build` → **reload** on the extensions card → reload the LinkedIn tab |
| A page, a style, an icon | The same — those are copied into `dist/` by the build, not read from `extension/` |
| The React version | Replace the files in [`extension/vendor/`](../extension/vendor/); there is no bundler to re-run |
| Anything at all, before you call it done | `npm run check` |

Reloading the extension does **not** re-inject into open tabs. The card reload and the LinkedIn tab
reload are two separate steps, and skipping the second is the usual reason a change appears to have
had no effect.

## Making an installer for someone else

```bash
npm run package
```

It runs `npm run check` first, so an archive can only be cut from a tree that typechecks, builds,
passes its tests and validates. It writes two files into `releases/`:

- `profile-vault-react-3.9.2.zip` — `INSTALL.md` beside an `extension/` folder that is a
  byte-for-byte copy of `dist/`
- `profile-vault-react-3.9.2.zip.sha256` — in the `<digest>  <name>` shape `sha256sum -c` expects

The packager reads its own archive back and compares every file against `dist/` before writing it,
so a corrupted entry fails here rather than on someone else's machine.

Hand over the `.zip`; the recipient follows **Route A**.

## Where your data lives

Saved profiles, the import queue and collected applicants live in the **browser's own IndexedDB**,
under `profile-table-collector`. Not in the repository, not in `dist/`, not in a file you can copy.

That means:

- A fresh setup starts with an empty vault. So does a second browser on the same machine.
- An unpacked extension's identity — and therefore its storage — is derived from the **folder path**.
  Move, rename or delete the folder Chrome loads and the extension comes back as a *different*
  extension with an empty vault. The old data is not deleted; it belongs to the old path, and moving
  the folder back recovers it.
- To move saved profiles to another device: **Export all CSV** on Saved Profiles there, **Import CSV**
  here. Applicants are export-only — **Download CSV** exports them for a spreadsheet, but there is no
  applicant CSV import, so they stay on the device that collected them.
- **Remove** on the extensions card deletes everything saved on that device. Export first.

## If something goes wrong

| What you see | What it means |
|---|---|
| `"tsc is not recognized"` and `dist/` is gone | `scripts/build.mjs` was run directly. Run `npm run build`; it will rebuild what the failed run deleted |
| `"Manifest file is missing or unreadable"` | The wrong folder was selected. It must be `dist` — or, from the installer zip, `extension` |
| The card loads but says the service worker is missing | `extension/` was selected instead of `dist/`, or `npm run build` has never been run |
| `npm test` reports no tests found | Node is older than 21 and cannot expand the test glob. Upgrade to Node 22 LTS |
| The popup shows a different build ID than `dist/build-meta.json` | A stale load. Press **reload** on the card, then reload the LinkedIn tab |
| The popup opens but nothing happens on LinkedIn | The tab predates the install or the last reload, so no reader is in it. Reload the tab |
| The extension vanished after restarting the browser | Its folder was moved, renamed, deleted, or is on a drive that was not connected. Put it back and **Load unpacked** again |
| An empty vault after moving the folder | Storage follows the old path. Move the folder back — see *Where your data lives* |
| A *"Disable developer mode extensions"* bubble at startup | Normal for any unpacked extension. Dismissing it leaves the extension enabled |
| `npm run check` fails at *docs:check* | A Markdown link in `docs/` points at a file that does not exist. The output names the file and the link |

## What setting up does **not** prove

`npm run check` runs against fixtures. **Fixtures are not the live DOM.** A green check says the code
compiles, the pure cores behave and `dist/` is loadable — it says nothing about whether LinkedIn's
current markup still matches what the readers expect. Confirming that is a person's step: load
`dist/`, open a real page, press a button.

## Before you start changing things

This project has conventions that will bite an unaware contributor — clicking rules, merge-only
collectors, a React 16 runtime with no hooks, and cores that must stay DOM-free.

- **[CLAUDE.md](../CLAUDE.md)** — the working brief, and the non-negotiable rules. Read it first.
- **[WORKFLOW.md](WORKFLOW.md)** — how a change is made, checked and recorded.
- **[TECH_STACK.md](TECH_STACK.md)** — what runs, and why each piece was chosen.
- **[CHANGELOG.md](CHANGELOG.md)** — the reasoning behind every rule: which live defect caused it,
  what was tried first, why an approach was rejected.

Every session starts with the Project Time Machine, which records each change as a revertible task:

```bash
node project-time-machine/scripts/status.js
node project-time-machine/scripts/audit.js
```
