// Main-camera smoke run (dev tool, not part of any test suite).
//
// Drives the built Electron app with Playwright through the main camera: picks camera 2 as the
// main camera in the layout pane, checks the preview outside any section now shows camera 2 in
// the PiP, adds a Full Camera section with C and checks it fills the frame with camera 2,
// checks camera 1 got its own rotation/mirror controls in the Cameras section, undoes and
// redoes the choice, saves, relaunches and checks the project came back unchanged. The final
// project is kept in --out as `main-camera-smoke.openscreen` for a CLI export.
//
// Usage (Windows, from the repo root):
//   npm run build-vite
//   node scripts/editor-main-camera-smoke.mjs --source <projectId> --out <dir> [--bin <dir>]
//
// Exit code 1 when any check failed.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SOURCE_ID = arg("source");
const OUT = arg("out");
const BIN = arg("bin", path.join(ROOT, "electron", "native", "bin", `win32-${process.arch}`));
if (!SOURCE_ID || !OUT) {
	console.error(
		"usage: node scripts/editor-main-camera-smoke.mjs --source <projectId> --out <dir>",
	);
	process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const PROJECTS = path.join(process.env.APPDATA ?? "", "openscreen", "projects");
const COPY_ID = `proj_${randomUUID()}`;
const COPY_FILE = path.join(PROJECTS, `${COPY_ID}.openscreen`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function note(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

const readDoc = () => JSON.parse(fs.readFileSync(COPY_FILE, "utf8"));
function deskState(doc = readDoc()) {
	const legacy = doc.legacyEditor ?? {};
	return {
		mainCamera: legacy.mainCamera,
		fulls: legacy.cameraFullscreenRegions ?? [],
		layouts: legacy.cameraLayoutRegions ?? [],
		desks: legacy.deskRegions ?? [],
	};
}
// Saves are asynchronous: poll the file until the predicate holds or the time is up.
async function waitState(predicate, timeoutMs = 8000) {
	const end = Date.now() + timeoutMs;
	let state = deskState();
	while (Date.now() < end) {
		state = deskState();
		try {
			if (predicate(state)) return { ok: true, state };
		} catch {
			// a half-written file: keep polling
		}
		await sleep(200);
	}
	return { ok: false, state };
}

/** A start time with `lengthSec` free of the first clip's trims and of every camera section. */
function freeSpot(lengthSec, doc = readDoc()) {
	const clip = doc.timeline.clips[0];
	const offset = clip.timelineStartSec - clip.sourceStartSec;
	const busy = [];
	for (const trim of doc.timeline.trimRanges ?? []) {
		if (trim.assetId !== clip.assetId || (trim.clipId && trim.clipId !== clip.id)) continue;
		busy.push([trim.startSec + offset, trim.endSec + offset]);
	}
	const legacy = doc.legacyEditor ?? {};
	for (const row of [
		...(legacy.cameraFullscreenRegions ?? []),
		...(legacy.cameraLayoutRegions ?? []),
		...(legacy.deskRegions ?? []),
	]) {
		busy.push([row.startMs / 1000, row.endMs / 1000]);
	}
	busy.sort((a, b) => a[0] - b[0]);
	let at = clip.timelineStartSec + 1;
	for (const [start, end] of busy) {
		if (at < end + 1 && at + lengthSec > start - 1) at = Math.ceil(end) + 1;
	}
	return at;
}

const source = JSON.parse(fs.readFileSync(path.join(PROJECTS, `${SOURCE_ID}.openscreen`), "utf8"));
source.project.id = COPY_ID;
source.project.title = `Main camera smoke ${new Date().toISOString()}`;
source.project.updatedAt = new Date().toISOString();
fs.writeFileSync(COPY_FILE, JSON.stringify(source));
console.log(`copy: ${COPY_FILE}`);

const log = fs.createWriteStream(path.join(OUT, "electron.log"));
const consoleErrors = [];

async function launch() {
	const app = await electron.launch({
		args: [ROOT, "--lang=en-US"],
		cwd: ROOT,
		env: {
			...process.env,
			OPENSCREEN_COMPOSITOR_VIEW_NODE: path.join(BIN, "compositor_view.node"),
			OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
			PATH: `${BIN};${process.env.PATH}`,
		},
		timeout: 60_000,
	});
	const proc = app.process();
	proc.stdout?.on("data", (d) => log.write(d));
	proc.stderr?.on("data", (d) => log.write(d));
	const hud = await app.firstWindow({ timeout: 60_000 });
	await hud.waitForLoadState("domcontentloaded");
	// Switching closes the HUD window under the evaluate, so its rejection is expected.
	await hud.evaluate(() => window.electronAPI.switchToEditor()).catch(() => undefined);
	let editor = null;
	for (let i = 0; i < 60 && !editor; i++) {
		editor = app.windows().find((w) => w.url().includes("windowType=editor")) ?? null;
		if (!editor) await sleep(500);
	}
	if (!editor) throw new Error("editor window did not open");
	editor.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
	editor.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
	await editor.waitForLoadState("domcontentloaded");
	const preview = editor.getByTestId("preview");
	await preview.waitFor({ state: "visible", timeout: 30_000 });
	await sleep(8000); // project load + first composed frame
	return { app, proc, editor, preview };
}

async function close({ app, proc }) {
	await Promise.race([app.close(), sleep(8000)]);
	try {
		proc.kill();
	} catch {
		// already gone
	}
}

function driver(editor, preview) {
	const time = async () => Number(await preview.getAttribute("data-current-time-sec"));
	const canvas = editor.locator('[class*="_tlRulerRow_"] [class*="_tlCanvas_"]').first();
	let totalSec = null;
	const clickRulerAt = async (frac) => {
		const box = await canvas.boundingBox();
		if (!box) throw new Error("no ruler");
		await editor.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
		await sleep(400);
	};
	// The ruler maps x linearly onto [0, total]; one probe click measures the total.
	const seekTo = async (sec) => {
		if (totalSec === null) {
			await clickRulerAt(0.5);
			totalSec = (await time()) / 0.5;
		}
		await clickRulerAt(sec / totalSec);
		await sleep(1500); // the compositor's frame for the new time
		return time();
	};
	const shot = async (name) => {
		const file = path.join(OUT, `${name}.png`);
		await preview.screenshot({ path: file });
		return file;
	};
	// The composed frame as raw RGBA, decoded in the page.
	const frame = async (name) => {
		const png = await preview
			.locator("canvas")
			.first()
			.screenshot({ path: path.join(OUT, `${name}-frame.png`) });
		return editor.evaluate(async (b64) => {
			const img = new Image();
			img.src = `data:image/png;base64,${b64}`;
			await img.decode();
			const c = document.createElement("canvas");
			c.width = img.width;
			c.height = img.height;
			const g = c.getContext("2d");
			g.drawImage(img, 0, 0);
			return {
				w: c.width,
				h: c.height,
				px: Array.from(g.getImageData(0, 0, c.width, c.height).data),
			};
		}, png.toString("base64"));
	};
	return { time, seekTo, shot, frame };
}

/** Mean per-channel difference of two equally sized frames, 0..255. */
function meanDifference(a, b) {
	if (a.w !== b.w || a.h !== b.h) return Number.NaN;
	let sum = 0;
	for (let i = 0; i < a.px.length; i += 4) {
		sum += Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]);
		sum += Math.abs(a.px[i + 2] - b.px[i + 2]);
	}
	return sum / ((a.px.length / 4) * 3);
}

const shots = [];
let exitCode = 0;
let session = null;
try {
	session = await launch();
	const { editor, preview } = session;
	const d = driver(editor, preview);
	const start = deskState();
	note("A: the copy opens without a main camera", start.mainCamera === undefined);

	// A. A plain moment, before and after picking camera 2 as the main camera.
	const plainAt = freeSpot(3);
	await d.seekTo(plainAt);
	shots.push(await d.shot("A-plain-project-preset"));
	await editor.getByRole("button", { name: "Camera layout", exact: true }).click();
	await sleep(600);
	// The source project may hide the camera outside sections ("no webcam"): show the PiP so the
	// default layout can be compared before and after the main-camera choice.
	const preset = editor.getByRole("group", { name: "Preset" });
	await preset.getByRole("button", { name: /^Picture in picture/ }).click();
	await sleep(1500);
	await d.seekTo(plainAt);
	const before2 = await d.frame("A-plain-pip-camera-1");
	shots.push(await d.shot("A-plain-pip-camera-1"));
	const picker = editor.getByRole("group", { name: "Main camera" });
	await picker.scrollIntoViewIfNeeded();
	await picker.getByRole("button", { name: /^Camera 2/ }).click();
	const picked = await waitState((s) => s.mainCamera === 1);
	note(
		"A: picking camera 2 stores it as the main camera",
		picked.ok,
		`mainCamera ${picked.state.mainCamera}`,
	);
	await d.seekTo(plainAt);
	const after = await d.frame("A-plain-camera-2");
	shots.push(await d.shot("A-plain-camera-2"));
	const pipDiff = meanDifference(after, before2);
	note("A: the PiP outside sections changed", pipDiff > 1, `mean difference ${pipDiff.toFixed(2)}`);

	// B. Camera 1 now has its own controls in the Cameras section; camera 2 has the note.
	const row0 = editor.getByTestId("camera-row-0");
	await row0.scrollIntoViewIfNeeded();
	note(
		"B: camera 1 shows its own rotation",
		(await row0.getByRole("group", { name: "Rotation" }).count()) > 0,
	);
	note(
		"B: camera 2 shows the controls-above note",
		(await editor
			.getByTestId("camera-row-1")
			.getByText(/controls above/)
			.count()) > 0,
	);

	// C. A Full Camera section shows camera 2 full frame.
	const fullAt = freeSpot(4);
	await d.seekTo(fullAt);
	await editor.keyboard.press("c");
	const added = await waitState((s) => s.fulls.length > start.fulls.length);
	const row = added.state.fulls[added.state.fulls.length - 1];
	note("C: C adds a Full Camera section", added.ok);
	const mid = (row.startMs + row.endMs) / 2000;
	await d.seekTo(mid);
	const full = await d.frame("C-full-camera-2");
	shots.push(await d.shot("C-full-camera-2"));
	note(
		"C: the section differs from the plain frame",
		meanDifference(full, after) > 20,
		`mean difference ${meanDifference(full, after).toFixed(1)}`,
	);

	// D. Undo and redo the main-camera choice (the C section is the newest step: undo twice).
	await editor.keyboard.press("Control+z");
	await editor.keyboard.press("Control+z");
	const undone = await waitState((s) => s.mainCamera === undefined);
	note(
		"D: Ctrl+Z twice removes the main camera again",
		undone.ok,
		`mainCamera ${undone.state.mainCamera}`,
	);
	await editor.keyboard.press("Control+Shift+z");
	await editor.keyboard.press("Control+Shift+z");
	const redone = await waitState((s) => s.mainCamera === 1 && s.fulls.length > start.fulls.length);
	note("D: Ctrl+Shift+Z twice brings both back", redone.ok);

	// E. Save, relaunch, compare.
	await editor.keyboard.press("Control+s");
	await sleep(1500);
	const saved = deskState();
	await close(session);
	session = null;
	session = await launch();
	const d2 = driver(session.editor, session.preview);
	note(
		"E: the reopened project keeps the main camera and section",
		JSON.stringify(deskState()) === JSON.stringify(saved),
	);
	await d2.seekTo(plainAt);
	shots.push(await d2.shot("E-reopened-plain"));
	await d2.seekTo(mid);
	shots.push(await d2.shot("E-reopened-full"));
	fs.writeFileSync(
		path.join(OUT, "final-state.json"),
		JSON.stringify({ ...deskState(), plainAt, midSec: mid }, null, 2),
	);
} catch (error) {
	note("run completed without an exception", false, String(error?.stack ?? error));
} finally {
	note(
		"no console errors in the editor",
		consoleErrors.length === 0,
		consoleErrors.slice(0, 5).join(" | "),
	);
	if (session) await close(session);
	log.end();
	if (fs.existsSync(COPY_FILE))
		fs.copyFileSync(COPY_FILE, path.join(OUT, "main-camera-smoke.openscreen"));
	fs.rmSync(COPY_FILE, { force: true });
	console.log(`removed copy: ${!fs.existsSync(COPY_FILE)}`);
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots }, null, 2));
	exitCode = results.every((x) => x.ok) ? 0 : 1;
}
process.exit(exitCode);
