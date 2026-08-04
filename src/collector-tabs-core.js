// The collector tab workflow.
//
// One Chrome window — the user's own, the one the importer page was opened in —
// holds exactly three surfaces for the whole run:
//
//   home         the extension's own import/dashboard tab, remembered on start
//   connections  ONE LinkedIn Connections tab, activated while the list is walked
//   profile      ONE reusable LinkedIn profile tab, activated for extraction and
//                navigated from profile to profile without ever being replaced
//
// A tab per profile is what made LinkedIn rate-limit the account and what made
// Chrome throttle every surface at once, so "reuse" is not an optimization here:
// `ensureProfileTab` creates a tab only when there is provably no live one, and a
// test drives a whole queue through it asserting exactly one create call.
//
// Every Chrome call is taken from an injected `env` rather than the `chrome`
// global. That is the only reason this policy can be tested at all — there is no
// jsdom and no Chrome in `npm test`, so background.ts injects the real APIs and
// the tests inject a fake window with the same shape.
//
// Export-free IIFE assigning globalThis.ProfileVaultTabs, per the project rule:
// it must load as a classic script, as an ESM side-effect import, and under
// Node's `await import()`. It touches no `document` and no `window` at load.

(() => {
  "use strict";

  /** Persisted so a suspended service worker never opens a second collector. */
  const KEYS = Object.freeze({
    HOME_TAB: "profileVaultHomeTabId",
    HOME_WINDOW: "profileVaultHomeWindowId",
    CONNECTIONS_TAB: "profileVaultConnectionsTabId",
    PROFILE_TAB: "profileVaultProfileTabId",
    /**
     * The recruiter's own hiring tab.
     *
     * Tracked so a second command reuses it rather than opening another, but it
     * is deliberately **not** a collector tab: `closeCollectorTabs()` never
     * touches it, because it is the page the recruiter was working in and the
     * import run's completion policy has nothing to say about it.
     */
    APPLICANT_TAB: "profileVaultApplicantTabId"
  });

  const ROLE = Object.freeze({
    HOME: "home",
    CONNECTIONS: "connections",
    PROFILE: "profile",
    APPLICANT: "applicant"
  });

  /**
   * What happens to the collector tabs when the queue finishes.
   *
   * Requirement 13 asks for ONE consistent policy rather than a per-path guess,
   * so it is named here, applied in exactly one function, and asserted by a test:
   * both collector tabs are closed, and the Saved Profiles table is opened or
   * activated in the window the run started from.
   */
  const COMPLETION_POLICY = "close-collectors-open-saved-profiles";

  function toId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /**
   * Same page, ignoring query, hash and a trailing slash.
   * Used to decide "is this tab already where it needs to be?" — reloading a tab
   * that is already on the Connections page throws away the list LinkedIn has
   * already rendered.
   */
  function sameTarget(current, expected) {
    if (!expected) return true;
    try {
      const left = new URL(String(current || ""));
      const right = new URL(String(expected));
      const path = (value) => value.replace(/\/+$/, "").toLowerCase();
      return left.origin === right.origin && path(left.pathname) === path(right.pathname);
    } catch {
      return false;
    }
  }

  /**
   * Build the controller over an injected Chrome-shaped environment.
   *
   * `env.tabs`    get / create / update / remove / query
   * `env.windows` get / update
   * `env.storage` get / set / remove   (chrome.storage.local)
   */
  function createTabController(env = {}) {
    const tabs = env.tabs || {};
    const windows = env.windows || {};
    const storage = env.storage || {};

    async function readKey(key) {
      const stored = await storage.get(key);
      return toId(stored?.[key]);
    }

    async function writeKey(key, value) {
      await storage.set({ [key]: value });
    }

    /** The stored tab, or null once it has been closed (and then forgotten). */
    async function liveTab(key) {
      const tabId = await readKey(key);
      if (!tabId) return null;
      try {
        const tab = await tabs.get(tabId);
        if (!tab || !toId(tab.id)) throw new Error("gone");
        return tab;
      } catch {
        await storage.remove(key);
        return null;
      }
    }

    async function tabUrl(tab) {
      return String(tab?.url || tab?.pendingUrl || "");
    }

    /** Step 1: remember where the run was started from. */
    async function rememberHome({ tabId = null, windowId = null } = {}) {
      const home = toId(tabId);
      const window = toId(windowId);
      if (home) await writeKey(KEYS.HOME_TAB, home);
      if (window) await writeKey(KEYS.HOME_WINDOW, window);
      return { tabId: home, windowId: window };
    }

    async function getHome() {
      return {
        tabId: await readKey(KEYS.HOME_TAB),
        windowId: await readKey(KEYS.HOME_WINDOW)
      };
    }

    /**
     * The window every collector tab is created in.
     *
     * The remembered window when it still exists, otherwise the window the home
     * tab now lives in, otherwise null — and a null `windowId` makes
     * `tabs.create` fall back to Chrome's current window rather than failing.
     */
    async function targetWindowId() {
      const stored = await readKey(KEYS.HOME_WINDOW);
      if (stored) {
        try {
          const found = await windows.get(stored);
          if (found) return stored;
        } catch {
          await storage.remove(KEYS.HOME_WINDOW);
        }
      }
      const homeTabId = await readKey(KEYS.HOME_TAB);
      if (homeTabId) {
        try {
          const tab = await tabs.get(homeTabId);
          const windowId = toId(tab?.windowId);
          if (windowId) {
            await writeKey(KEYS.HOME_WINDOW, windowId);
            return windowId;
          }
        } catch {
          await storage.remove(KEYS.HOME_TAB);
        }
      }
      return null;
    }

    /**
     * Make a tab the one Chrome is painting.
     *
     * Chrome does not render a background tab or a minimized window, and an
     * unrendered LinkedIn page never lazy-loads — every "is it finished?" signal
     * reads a frozen DOM as finished. Activating is therefore part of collecting,
     * not a nicety. The window is raised out of minimized state but by default
     * deliberately NOT focused: stealing focus from whatever the user is typing
     * into is worse than a background run taking longer.
     *
     * `focusWindow` is the exception, and it exists for one situation: the user
     * has just pressed a button that means "go and do this on that page". A tab
     * activated in a window the user is not looking at is, to them, a button
     * that did nothing — so a *direct command* raises the window, while the
     * heartbeat-driven import run still never does.
     */
    async function activate(tabId, { focusWindow = false } = {}) {
      const id = toId(tabId);
      if (!id) return false;
      try {
        await tabs.update(id, { active: true });
      } catch {
        return false;
      }
      try {
        const tab = await tabs.get(id);
        const windowId = toId(tab?.windowId);
        if (!windowId) return true;
        const found = await windows.get(windowId);
        if (focusWindow) {
          const properties = { focused: true };
          if (found?.state === "minimized") properties.state = "normal";
          await windows.update(windowId, properties);
        } else if (found && found.state === "minimized") {
          await windows.update(windowId, { state: "normal", focused: false });
        }
      } catch {
        // A tab with no reachable window is still activated as far as we can tell.
      }
      return true;
    }

    /**
     * Reuse the stored tab for `key`, or create exactly one.
     *
     * This is the single place any collector tab is ever created. Reuse wins
     * whenever the stored tab is still alive, which is what guarantees one
     * Connections tab and one profile collector tab no matter how many times a
     * suspended worker re-enters the workflow.
     */
    async function ensureTab(key, url, { activateTab = true, navigate = true, focusWindow = false } = {}) {
      const existing = await liveTab(key);
      if (existing) {
        const id = toId(existing.id);
        const current = await tabUrl(existing);
        // Only navigate when the tab is not already on the target page.
        if (navigate && url && !sameTarget(current, url)) {
          await tabs.update(id, { url });
        }
        if (activateTab) await activate(id, { focusWindow });
        return { tabId: id, created: false };
      }

      const windowId = await targetWindowId();
      const properties = { url, active: Boolean(activateTab) };
      if (windowId) properties.windowId = windowId;
      const created = await tabs.create(properties);
      const tabId = toId(created?.id);
      if (!tabId) throw new Error("Chrome did not return a tab id for the collector tab.");
      await writeKey(key, tabId);
      if (activateTab) await activate(tabId, { focusWindow });
      return { tabId, created: true };
    }

    return {
      KEYS,
      ROLE,
      COMPLETION_POLICY,
      sameTarget,

      rememberHome,
      getHome,
      targetWindowId,
      activate,

      /** Steps 2-3: the one Connections tab, in the home window, made visible. */
      async ensureConnectionsTab(url) {
        return ensureTab(KEYS.CONNECTIONS_TAB, url, { activateTab: true });
      },

      /** Steps 6-7: the one reusable profile collector tab, made visible. */
      async ensureProfileTab(url) {
        return ensureTab(KEYS.PROFILE_TAB, url, { activateTab: true });
      },

      /**
       * The recruiter's hiring tab, opened or reused **in the window the command
       * came from**, and brought to the front.
       *
       * The applicant commands are pressed from the extension's own Applicants
       * page, which is a different tab — often in a different window. Merely
       * activating the hiring tab there is invisible to the user, so this is one
       * of the two places allowed to take focus (the other is the sign-in page):
       * they have just asked to be taken to that page.
       *
       * It is tracked so a second command reuses the same tab, but it is never
       * closed by `closeCollectorTabs()` — it is the recruiter's own working
       * page, not a collector this extension owns.
       */
      async ensureApplicantTab(url) {
        return ensureTab(KEYS.APPLICANT_TAB, url, { activateTab: true, focusWindow: true });
      },

      /**
       * A short-lived tab for one document, opened in the background.
       *
       * Not a collector tab and never tracked: it exists for the seconds it
       * takes to open the applicant's resume, save it and close it again, and
       * `closeCollectorTabs()` must never know about it. It is created
       * **inactive**, because the whole point of the cycle is that it is
       * autonomous — the recruiter should not have a tab flashing in front of
       * them, and should certainly not have to close one.
       *
       * It lives here rather than in the worker for the same reason every other
       * tab does (rule 12): there is exactly one place a tab is created, and it
       * is the one place that is tested without a browser.
       */
      async openDocumentTab(url) {
        const address = String(url || "").trim();
        if (!address) return null;
        const created = await tabs.create({ url: address, active: false });
        return toId(created?.id);
      },

      /** Close a tab this controller opened. Never throws; a gone tab is closed. */
      async closeDocumentTab(tabId) {
        const id = toId(tabId);
        if (!id) return false;
        try {
          await tabs.remove(id);
          return true;
        } catch {
          return false;
        }
      },

      /** Remember a hiring tab the user opened themselves, so it is reused. */
      async rememberApplicantTab(tabId) {
        const id = toId(tabId);
        if (!id) return null;
        await writeKey(KEYS.APPLICANT_TAB, id);
        return id;
      },

      /**
       * Step 8: send THE SAME collector tab to the next profile.
       *
       * Always navigates, because the next profile is a different URL and a tab
       * that is already on it has nothing left to collect. Never creates a tab
       * when one exists — that is the whole point of this function.
       */
      async navigateProfileTab(url) {
        const existing = await liveTab(KEYS.PROFILE_TAB);
        if (!existing) return ensureTab(KEYS.PROFILE_TAB, url, { activateTab: true });
        const tabId = toId(existing.id);
        await tabs.update(tabId, { url, active: true });
        await activate(tabId);
        return { tabId, created: false };
      },

      async getConnectionsTabId() {
        const tab = await liveTab(KEYS.CONNECTIONS_TAB);
        return toId(tab?.id);
      },

      async getProfileTabId() {
        const tab = await liveTab(KEYS.PROFILE_TAB);
        return toId(tab?.id);
      },

      /**
       * Is a collector tab in a state LinkedIn will actually render?
       *
       * Requirements 11-12: extraction pauses when this goes false and resumes
       * when it comes back, instead of saving whatever half-rendered page it
       * could see.
       */
      async isRenderable(key) {
        const tab = await liveTab(key);
        if (!tab || !tab.active) return false;
        const windowId = toId(tab.windowId);
        if (!windowId) return true;
        try {
          const found = await windows.get(windowId);
          return Boolean(found) && found.state !== "minimized";
        } catch {
          return false;
        }
      },

      async isProfileTabRenderable() {
        return this.isRenderable(KEYS.PROFILE_TAB);
      },

      async isConnectionsTabRenderable() {
        return this.isRenderable(KEYS.CONNECTIONS_TAB);
      },

      /** True when `tabId` is one of the two collector surfaces. */
      async roleOf(tabId) {
        const id = toId(tabId);
        if (!id) return "";
        if (id === (await readKey(KEYS.PROFILE_TAB))) return ROLE.PROFILE;
        if (id === (await readKey(KEYS.CONNECTIONS_TAB))) return ROLE.CONNECTIONS;
        if (id === (await readKey(KEYS.HOME_TAB))) return ROLE.HOME;
        return "";
      },

      /** Forget a collector tab the user closed, so the next step reopens one. */
      async forgetClosedTab(tabId) {
        const id = toId(tabId);
        if (!id) return "";
        const role = await this.roleOf(id);
        if (role === ROLE.PROFILE) await storage.remove(KEYS.PROFILE_TAB);
        else if (role === ROLE.CONNECTIONS) await storage.remove(KEYS.CONNECTIONS_TAB);
        else if (role === ROLE.HOME) await storage.remove(KEYS.HOME_TAB);
        return role;
      },

      async closeTab(key) {
        const tab = await liveTab(key);
        if (!tab) return false;
        try {
          await tabs.remove(toId(tab.id));
        } catch {
          // Already closed by the user; forgetting it is the whole job here.
        }
        await storage.remove(key);
        return true;
      },

      /** Step 13, first half: the one completion policy, applied in one place. */
      async closeCollectorTabs() {
        const connections = await this.closeTab(KEYS.CONNECTIONS_TAB);
        const profile = await this.closeTab(KEYS.PROFILE_TAB);
        return { policy: COMPLETION_POLICY, closedConnections: connections, closedProfile: profile };
      },

      /**
       * Step 13, second half: show the user what was collected.
       *
       * The home tab is reused when it is already the extension's own page, so a
       * finished run lands back where it started rather than piling up tabs.
       */
      async openSavedProfilesTab(url) {
        const homeTabId = await readKey(KEYS.HOME_TAB);
        if (homeTabId) {
          try {
            const tab = await tabs.get(homeTabId);
            if (tab) {
              const current = await tabUrl(tab);
              if (!sameTarget(current, url)) await tabs.update(homeTabId, { url });
              await activate(homeTabId);
              return { tabId: homeTabId, created: false };
            }
          } catch {
            await storage.remove(KEYS.HOME_TAB);
          }
        }
        const windowId = await targetWindowId();
        const properties = { url, active: true };
        if (windowId) properties.windowId = windowId;
        const created = await tabs.create(properties);
        const tabId = toId(created?.id);
        if (tabId) await writeKey(KEYS.HOME_TAB, tabId);
        await activate(tabId);
        return { tabId, created: true };
      },

      /** Everything the downloadable diagnostics report says about the surfaces. */
      async describe() {
        const out = { policy: COMPLETION_POLICY, home: null, connections: null, profile: null };
        for (const [name, key] of [
          ["home", KEYS.HOME_TAB],
          ["connections", KEYS.CONNECTIONS_TAB],
          ["profile", KEYS.PROFILE_TAB]
        ]) {
          const tab = await liveTab(key);
          if (!tab) {
            out[name] = { tabId: null, active: false, url: "", windowId: null, windowState: "", renderable: false };
            continue;
          }
          let windowState = "";
          try {
            const found = await windows.get(toId(tab.windowId));
            windowState = String(found?.state || "");
          } catch {
            windowState = "";
          }
          out[name] = {
            tabId: toId(tab.id),
            active: Boolean(tab.active),
            url: await tabUrl(tab),
            status: String(tab.status || ""),
            windowId: toId(tab.windowId),
            windowState,
            renderable: Boolean(tab.active) && windowState !== "minimized"
          };
        }
        return out;
      },

      /** Clear Queue / Stop: forget every remembered surface. */
      async forgetAll() {
        await storage.remove([KEYS.CONNECTIONS_TAB, KEYS.PROFILE_TAB]);
      }
    };
  }

  globalThis.ProfileVaultTabs = { KEYS, ROLE, COMPLETION_POLICY, sameTarget, createTabController };
})();
