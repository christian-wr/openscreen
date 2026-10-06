// Desk-lane smoke run (dev tool, not part of any test suite).
//
// Drives the built Electron app with Playwright through the desk lane: picks camera 2 as the
// desk camera in the Cameras section, adds a desk section with the D key, checks that C is
// refused on top of it, turns its label off in the inspector, undoes and redoes that, saves,
// relaunches and checks the project came back unchanged. After every step it reads the saved
// project file and asserts the document state, and it captures the live preview in the middle
// of the desk section and at a plain moment for comparison. The final project is kept in
// --out as `desk-smoke.openscreen`, ready for a CLI export against the preview.
//
// Usage (Windows, from the repo root):
//   npm run build-vite
//   node scripts/editor-desk-smoke.mjs --source <projectId> --out <dir> [--bin <dir>]
//
//   --source  id of an existing project with at least two cameras on its first clip. It is NOT
//             modified: the run copies it to a new project id and deletes the copy at the end.
//   --out     directory for screenshots, the Electron log, results.json and the final project.
//   --bin     native bin dir holding compositor_view.node and the ffmpeg DLLs
//             (default electron/native/bin/win32-<arch>).
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
	console.error("usage: node scripts/editor-desk-smoke.mjs --source <projectId> --out <dir>");
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
		deskCamera: legacy.deskCamera,
		desks: legacy.deskRegions ?? [],
		fulls: legacy.cameraFullscreenRegions ?? [],
		layouts: legacy.cameraLayoutRegions ?? [],
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
source.project.title = `Desk smoke ${new Date().toISOString()}`;
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
	note(
		"A: the copy opens without desk sections or a desk camera",
		start.desks.length === 0 && start.deskCamera === undefined,
		`fulls ${start.fulls.length}, layouts ${start.layouts.length}`,
	);

	// A. Pick camera 2 as the desk camera in the Cameras section.
	await editor.getByRole("button", { name: "Camera layout", exact: true }).click();
	await sleep(600);
	const row = editor.getByTestId("camera-row-1");
	await row.scrollIntoViewIfNeeded();
	await row.getByLabel("Desk camera").click();
	const picked = await waitState((s) => s.deskCamera === 1);
	note(
		"A: picking camera 2 stores it as the desk camera",
		picked.ok,
		`deskCamera ${picked.state.deskCamera}`,
	);

	// B. A plain frame for comparison, then D at a free spot.
	const at = freeSpot(6);
	await d.seekTo(at - 0.6 > 0 ? at - 0.6 : at);
	const plain = await d.frame("B-plain");
	shots.push(await d.shot("B-plain"));
	const playhead = await d.seekTo(at);
	await editor.keyboard.press("d");
	const added = await waitState((s) => s.desks.length === 1);
	const desk = added.state.desks[0];
	note(
		"B: D adds a desk section at the playhead",
		added.ok && Math.abs(desk.startMs / 1000 - playhead) < 0.25,
		added.ok ? `${(desk.startMs / 1000).toFixed(2)}-${(desk.endMs / 1000).toFixed(2)} s` : "none",
	);
	const pill = editor.getByText(/^Desk · /).first();
	note(
		"B: the desk lane shows the section with the camera's name",
		(await pill.count()) > 0,
		(await pill.count()) > 0 ? await pill.innerText() : "",
	);

	// C. The middle of the section: the desk camera fills the frame.
	const mid = (desk.startMs + desk.endMs) / 2000;
	await d.seekTo(mid);
	const inDesk = await d.frame("C-desk-mid");
	shots.push(await d.shot("C-desk-mid"));
	const diff = meanDifference(inDesk, plain);
	note(
		"C: the frame in the section differs clearly from the plain frame",
		diff > 20,
		`mean difference ${diff.toFixed(1)}`,
	);

	// D. C on top of the desk section is refused and writes nothing.
	const beforeC = JSON.stringify(deskState());
	await editor.keyboard.press("c");
	await sleep(1500);
	const toast = editor.getByText(/Cannot place/i);
	note(
		"D: C over the desk section is refused",
		JSON.stringify(deskState()) === beforeC,
		(await toast.count()) > 0 ? "notice shown" : "no notice found",
	);

	// E. Inspector: select the desk pill, turn the label off.
	await pill.click();
	await sleep(600);
	note(
		"E: the inspector names the desk camera",
		(await editor.getByText("Desk camera").count()) > 0,
	);
	await editor.getByLabel("Show label").click();
	const labelOff = await waitState((s) => s.desks[0]?.deskLabel === false);
	note("E: the label switch stores deskLabel false", labelOff.ok);
	await d.seekTo(mid);
	shots.push(await d.shot("E-desk-mid-no-label"));

	// F. Undo and redo the label change.
	await editor.keyboard.press("Control+z");
	const undone = await waitState((s) => s.desks[0] && s.desks[0].deskLabel === undefined);
	note("F: Ctrl+Z brings the label back", undone.ok);
	await editor.keyboard.press("Control+Shift+z");
	const redone = await waitState((s) => s.desks[0]?.deskLabel === false);
	note("F: Ctrl+Shift+Z takes it away again", redone.ok);

	// G. Save, relaunch, compare.
	await editor.keyboard.press("Control+s");
	await sleep(1500);
	const saved = deskState();
	await close(session);
	session = null;
	session = await launch();
	const d2 = driver(session.editor, session.preview);
	const reopened = deskState();
	note(
		"G: the reopened project keeps the desk camera and section",
		JSON.stringify(reopened) === JSON.stringify(saved),
	);
	note("G: the desk lane is back", (await session.editor.getByText(/^Desk · /).count()) > 0);
	await d2.seekTo(mid);
	shots.push(await d2.shot("G-reopened-desk-mid"));
	fs.writeFileSync(
		path.join(OUT, "final-state.json"),
		JSON.stringify({ ...reopened, midSec: mid }, null, 2),
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
	if (fs.existsSync(COPY_FILE)) fs.copyFileSync(COPY_FILE, path.join(OUT, "desk-smoke.openscreen"));
	fs.rmSync(COPY_FILE, { force: true });
	console.log(`removed copy: ${!fs.existsSync(COPY_FILE)}`);
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots }, null, 2));
	exitCode = results.every((x) => x.ok) ? 0 : 1;
}
process.exit(exitCode);
