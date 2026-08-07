/**
 * The universal Stop.
 *
 * One button, one message, and every surface that can be busy has to honour it.
 * The failure this guards against is the one that makes a Stop button useless:
 * a control that is only rendered once the extension has noticed it is busy, or
 * a loop that checks the flag only between items rather than before each step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (file) => readFile(resolve(root, file), "utf8");

test("STOP_ALL is one shared literal, not a string repeated per caller", async () => {
  const messages = await read("src/messages.ts");
  assert.match(messages, /export const STOP_ALL = "PV_STOP_ALL"/, "one declaration, imported everywhere");

  for (const file of ["src/react/popup.tsx", "src/react/applicants-dashboard.tsx"]) {
    const source = await read(file);
    assert.match(source, /STOP_ALL/, `${file} must use the shared constant`);
    assert.ok(!/"PV_STOP_ALL"/.test(source), `${file} must not hard-code the literal`);
  }
});

test("the popup's Stop is always rendered and never behind a state check", async () => {
  const source = await read("src/react/popup.tsx");
  const render = source.slice(source.indexOf("  render() {"));
  const stopAt = render.indexOf('className="stop-all"');
  assert.ok(stopAt > 0, "the popup must render a universal Stop button");

  // It sits in the shell itself, above the panels, so it is present whichever
  // surface the popup happens to be showing.
  const applicantPanelAt = render.indexOf("this.renderApplicantPanel()");
  const importPanelAt = render.indexOf("this.renderImportPanel()");
  assert.ok(stopAt < applicantPanelAt && stopAt < importPanelAt, "Stop comes before every panel");

  // The old Stop was rendered only when `running || cooling || discovering`.
  // That is the bug this test exists to prevent coming back.
  assert.ok(
    !/\{running \|\| cooling \|\| discovering \? <button[^>]*>Stop</.test(source),
    "Stop must not be conditional on the extension already knowing it is busy"
  );
  // Disabled only while a stop is in flight — never because nothing is running.
  assert.match(render, /className="stop-all" type="button" disabled=\{stopping\}/, "only an in-flight stop disables it");
  assert.match(source, /Stop Everything/, "and it says what it stops");
  // The reassurance prose under the button was removed in 3.7.8 with the rest
  // of the explanatory text. That Stop discards nothing is asserted against the
  // worker below, which is where it is actually true rather than merely said.
  assert.ok(!/stop-all-hint/.test(source), "the popup carries no explanatory prose");
});

test("the popup's Stop sends the universal message, not the import one", async () => {
  const source = await read("src/react/popup.tsx");
  const handler = source.slice(source.indexOf("stopEverything = async"), source.indexOf("collectApplicant ="));
  assert.match(handler, /chrome\.runtime\.sendMessage\(\{ type: STOP_ALL \}\)/, "it must send STOP_ALL");
  assert.ok(!/IMPORT_MESSAGES\.STOP/.test(handler), "stopping only the import queue is not a universal stop");

  // The popup keeps the controls the specification requires and none of the
  // ones it forbids.
  assert.match(source, /Start Collecting/);
  assert.match(source, /IMPORT_MESSAGES\.START_COLLECTING/);
  for (const removed of ["Find Connections", "Collect All", "Retry Failed", "Clear Queue"]) {
    assert.ok(!source.includes(removed), `the popup must not surface "${removed}"`);
  }
});

test("the worker's Stop ends work in flight, in every tab, and discards nothing", async () => {
  const worker = await read("src/background.ts");
  const stop = worker.slice(worker.indexOf("async function stopEverything"), worker.indexOf("async function handleApplicantCommand"));

  assert.match(stop, /abortRunningWork\(\)/, "the generation token is what ends a pass already running");
  assert.match(stop, /await stopAllContentScripts\(\)/, "every LinkedIn tab must be told");
  assert.match(stop, /Queue\.stopSession/, "the queue session must be stopped");
  assert.match(stop, /clearHeartbeat/, "the heartbeat must not restart the run a minute later");
  assert.match(stop, /closeCollectorTabs/, "the collector tabs must be closed");

  // Stop ends work; it does not throw work away. Both stores are untouched.
  for (const destructive of ["clearProfiles", "clearApplicants", "Queue.clearQueue", "deleteProfile"]) {
    assert.ok(!stop.includes(destructive), `Stop must never call ${destructive}`);
  }

  // And it is handled before every other branch, so it is never queued behind
  // the very work it is trying to end.
  const listener = worker.slice(worker.indexOf("chrome.runtime.onMessage.addListener"));
  const stopBranch = listener.indexOf("message?.type === STOP_ALL");
  const applicantBranch = listener.indexOf('startsWith("PV_APPLICANT_")');
  const importBranch = listener.indexOf('startsWith("PV_IMPORT_")');
  assert.ok(stopBranch > 0, "the worker must handle STOP_ALL");
  assert.ok(stopBranch < applicantBranch && stopBranch < importBranch, "STOP_ALL is matched first");
});

test("the broadcast reaches every LinkedIn tab and survives a tab with no listener", async () => {
  const worker = await read("src/background.ts");
  const broadcast = worker.slice(worker.indexOf("async function stopAllContentScripts"), worker.indexOf("async function stopEverything"));
  assert.match(broadcast, /https:\/\/www\.linkedin\.com\/\*/, "every LinkedIn tab, not only the collector");
  assert.match(broadcast, /catch \{/, "a tab with no listener has nothing to stop and must not throw");
});

test("all three content scripts stop at their next step, not at their next item", async () => {
  for (const [file, surface] of [
    ["content.js", "profile"],
    ["connections.js", "connections"],
    ["applicants.js", "applicants"]
  ]) {
    const source = await read(file);
    assert.match(source, /PV_STOP_ALL/, `${file} must handle the universal stop`);
    assert.match(source, /state\.aborted = true/, `${file} must record that it was stopped`);
    assert.match(source, new RegExp(`surface: "${surface}"`), `${file} must say which surface replied`);
  }

  // Each one checks the flag inside its own walking loop, before it steps.
  const profile = await read("content.js");
  const scan = profile.slice(profile.indexOf("async function performLazyScrollAndCollect"));
  const abortAt = scan.indexOf("if (state.aborted) throw stoppedError()");
  const scrollAt = scan.indexOf("scrollProfileTo(scan.position, target)");
  assert.ok(abortAt > 0 && abortAt < scrollAt, "the profile scan must check before it scrolls again");

  const connections = await read("connections.js");
  const loop = connections.slice(connections.indexOf("      for (;;) {"));
  assert.ok(loop.indexOf("if (state.aborted)") < loop.indexOf("const midChallenge"), "discovery checks Stop first of all");
  assert.match(loop, /stopped: true[\s\S]{0,240}atBottom: false/, "a stopped pass must never read as a finished list");

  const applicants = await read("applicants.js");
  assert.match(applicants, /function assertRunnable\(\)[\s\S]{0,160}state\.aborted/, "one guard, checked everywhere");
});

test("a stop is reported as an interruption, never as a failed record", async () => {
  const profile = await read("content.js");
  assert.match(profile, /stopped: Boolean\(error\?\.stopped\)/, "the profile reply must distinguish a stop from a failure");

  const applicants = await read("applicants.js");
  const run = applicants.slice(applicants.indexOf("async function extractAllApplicants"));
  const stoppedAt = run.indexOf("if (error?.stopped)");
  const failedAt = run.indexOf("state.run.failed += 1");
  assert.ok(stoppedAt > 0 && stoppedAt < failedAt, "a stop must be handled before anything is counted as a failure");
});

test("the popup offers all three surfaces by name", async () => {
  const source = await read("src/react/popup.tsx");
  assert.match(source, />Connections Collector</);
  assert.match(source, />Job Applicants</);
  assert.match(source, />Saved Profiles</);
  assert.match(source, /openApplicants = \(\) => chrome\.tabs\.create/, "and the applicants page must open");

  // 3.7.8: the applicant controls are ALWAYS offered. Gating them on the active
  // tab meant the section the recruiter opened the popup for was absent most of
  // the time, and the gate bought nothing — the worker resolves a hiring tab in
  // any window and re-opens the last one it was on, so the command works from
  // anywhere and says so when it cannot.
  assert.match(source, /detectSurface = async/, "the popup still knows which page it is over");
  const panel = source.slice(source.indexOf("renderApplicantPanel()"), source.indexOf("signIn = async"));
  assert.ok(!/if \(this\.state\.surface !== "applicants"\) return null/.test(panel),
    "the applicant panel must not be hidden behind the active tab");
  assert.match(panel, /Collect Applicant List/, "and it still offers the commands");
  assert.match(panel, /Collect This Applicant/);
  assert.match(panel, /Review &amp; Export/);
  // The prose describing what it will not do was removed in 3.7.8 with every
  // other explanatory paragraph. What it will not do is enforced by
  // FORBIDDEN_APPLICANT_CONTROL_PATTERN and asserted against the policy itself,
  // which is where it is true rather than merely stated.
  assert.ok(!/<p className="import-hint">\s*Reads only what/.test(panel), "the panel carries no explanatory prose");
});

test("the Stop button is styled to be found, not to blend in", async () => {
  const css = await read("popup.css");
  const theme = await read("theme.css");
  const rule = css.slice(css.indexOf(".stop-all {"), css.indexOf(".import-panel {"));
  assert.match(rule, /width: 100%/, "full width, so it is not one small button among many");
  // It carries no `.danger` class of its own, so the red has to be stated — and
  // stated from the shared tokens, so it cannot drift away from the Stop on
  // every other screen the way four hand-written palettes did.
  assert.match(rule, /var\(--pv-bad-lit\)[\s\S]*?var\(--pv-bad-fill\)/, "the same red `.danger` uses on every other screen");
  assert.match(theme, /\.danger \{\s*\n\s*background: linear-gradient\(180deg, var\(--pv-bad-lit\) 0%, var\(--pv-bad-fill\) 100%\)/,
    "and `.danger` is built from those same two tokens");
  assert.match(rule, /focus-visible/, "and reachable from the keyboard");
});
