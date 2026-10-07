// HUD desk-camera smoke run (dev tool, not part of any test suite).
//
// Opens the HUD's device settings with Playwright, picks a desk camera, checks it lands in
// recording-settings.json as `camDeskDevice`, switches back to "None" and checks that too. The
// user's recording-settings.json is backed up first and restored byte for byte at the end,
// whatever happens. Playwright clicks reach the DOM below the HUD's click-through layer, so
// this proves the list and its persistence, not that a real pointer could reach it.
//
// Usage (Windows, from the repo root):
//   npm run build-vite
//   node scripts/hud-desk-camera-smoke.mjs --out <dir>
//
// Exit code 1 when any check failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--out");
const OUT = i >= 0 ? process.argv[i + 1] : null;
if (!OUT) {
	console.error("usage: node scripts/hud-desk-camera-smoke.mjs --out <dir>");
	process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const PREFS = path.join(process.env.APPDATA ?? "", "openscreen", "recording-settings.json");
const BACKUP = fs.readFileSync(PREFS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function note(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}
const readPrefs = () => JSON.parse(fs.readFileSync(PREFS, "utf8"));
async function waitPrefs(predicate, timeoutMs = 6000) {
	const end = Date.now() + timeoutMs;
	let prefs = readPrefs();
	while (Date.now() < end) {
		try {
			prefs = readPrefs();
			if (predicate(prefs)) return { ok: true, prefs };
		} catch {
			// a half-written file: keep polling
		}
		await sleep(200);
	}
	return { ok: false, prefs };
}

let app = null;
try {
	app = await electron.launch({
		args: [ROOT, "--lang=en-US"],
		cwd: ROOT,
		env: { ...process.env, OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1" },
		timeout: 60_000,
	});
	const hud = await app.firstWindow({ timeout: 60_000 });
	await hud.waitForLoadState("domcontentloaded");
	await sleep(4000);
	await hud.getByRole("button", { name: "Device settings" }).first().click();
	await sleep(1000);
	const group = hud.getByRole("radiogroup", { name: "Desk camera" });
	note("the device settings show a desk camera list", (await group.count()) > 0);
	const items = group.getByRole("radio");
	const names = [];
	for (let k = 0; k < (await items.count()); k++)
		names.push((await items.nth(k).innerText()).trim());
	note(
		"the list offers None and the recorded cameras",
		names[0] === "None" && names.length >= 3,
		names.join(" | "),
	);
	await group.scrollIntoViewIfNeeded();
	await hud.screenshot({ path: path.join(OUT, "hud-desk-list.png") });
	const locked = await items.nth(names.length - 1).isDisabled();
	if (locked) {
		// Same lock as the additional cameras: only with native Windows capture. Say why and stop.
		const hint = await hud.getByText(/native|Windows/i).allInnerTexts();
		note("the desk list is locked in this run", false, hint.join(" | "));
		throw new Error("desk list locked");
	}

	// Pick the last offered camera (an additional one), then None again.
	await items.nth(names.length - 1).click();
	const picked = await waitPrefs(
		(p) => p.camDeskDevice && p.camDeskDevice.name === names[names.length - 1],
	);
	note(
		"picking a camera stores camDeskDevice",
		picked.ok,
		JSON.stringify(picked.prefs.camDeskDevice ?? null),
	);
	note(
		"the picked entry is checked",
		(await items.nth(names.length - 1).getAttribute("aria-checked")) === "true",
	);
	await items.nth(0).click();
	const none = await waitPrefs((p) => p.camDeskDevice === null || p.camDeskDevice === undefined);
	note("None clears camDeskDevice", none.ok, JSON.stringify(none.prefs.camDeskDevice ?? null));
} catch (error) {
	note("run completed without an exception", false, String(error?.stack ?? error));
} finally {
	if (app) await Promise.race([app.close(), sleep(8000)]);
	fs.writeFileSync(PREFS, BACKUP);
	note("recording-settings.json restored byte for byte", fs.readFileSync(PREFS).equals(BACKUP));
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
