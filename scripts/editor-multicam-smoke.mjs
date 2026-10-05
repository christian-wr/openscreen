// Multi-camera editor smoke run (dev tool, not part of any test suite).
//
// Drives the built Electron app with Playwright through the multi-camera editor: adds a
// "camera + inset" section from the layout menu, picks its cameras in the inspector, converts
// a Full Camera section (key C) to "screen + camera" and back, undoes and redoes that, drags
// a PiP window in the preview, applies a perspective correction in the calibration dialog,
// saves, relaunches the app and checks the project came back unchanged. After every step it
// reads the saved project file and asserts the document state, and it captures the live
// preview inside each section.
//
// Usage (Windows, from the repo root):
//   npm run build-vite
//   npm run build:native:compositor   # then copy compositor_view.node into the bin dir below
//   node scripts/editor-multicam-smoke.mjs --source <projectId> --out <dir> [--bin <dir>]
//
//   --source  id of an existing project with at least two cameras on its first clip
//             (e.g. proj_7bc8…). It is NOT modified: the run copies it to a new project id
//             with a fresh `updatedAt`, so the editor opens the copy, and deletes the copy at
//             the end. Back up %APPDATA%\openscreen\projects first anyway: the editor may
//             touch other state while it runs.
//   --out     directory for screenshots, the Electron log and results.json.
//   --bin     native bin dir holding compositor_view.node and the ffmpeg DLLs
//             (default electron/native/bin/win32-<arch>).
//
// The app is launched with the repo root as its entry (not dist-electron/main.js, which would
// move userData to Roaming\Electron) and with OPENSCREEN_DISABLE_CONTENT_PROTECTION=1.
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
	console.error("usage: node scripts/editor-multicam-smoke.mjs --source <projectId> --out <dir>");
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

function readDoc() {
	return JSON.parse(fs.readFileSync(COPY_FILE, "utf8"));
}
function cameraState(doc = readDoc()) {
	const legacy = doc.legacyEditor ?? {};
	return {
		layouts: legacy.cameraLayoutRegions ?? [],
		fulls: legacy.cameraFullscreenRegions ?? [],
		settings: legacy.cameraSettings ?? null,
	};
}
// Saves are asynchronous: poll the file until the predicate holds or the time is up.
async function waitState(predicate, timeoutMs = 8000) {
	const end = Date.now() + timeoutMs;
	let state = cameraState();
	while (Date.now() < end) {
		state = cameraState();
		try {
			if (predicate(state)) return { ok: true, state };
		} catch {
			// a half-written state: keep polling
		}
		await sleep(200);
	}
	return { ok: false, state };
}
const brief = (rows) =>
	rows
		.map(
			(r) =>
				`${r.template ?? "full"}[${(r.slots ?? []).map((s) => s.camera).join(",")}]@${(
					r.startMs / 1000
				).toFixed(2)}-${(r.endMs / 1000).toFixed(2)}`,
		)
		.join(" ");

// 1. The copy the editor opens: newest `updatedAt`, fresh id, otherwise the source verbatim.
const source = JSON.parse(fs.readFileSync(path.join(PROJECTS, `${SOURCE_ID}.openscreen`), "utf8"));
source.project.id = COPY_ID;
source.project.title = `Multi-camera smoke ${new Date().toISOString()}`;
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
		await sleep(1200); // the compositor's frame for the new time
		return time();
	};
	const xOf = async (sec) => {
		const box = await canvas.boundingBox();
		return box.x + (box.width * sec) / totalSec;
	};
	// Clicks the camera-lane pill under `sec`: Full Camera and layout sections share that lane.
	const selectPillAt = async (sec) => {
		const x = await xOf(sec);
		const pills = editor.locator('[class*="_lanePill_"][class*="_laneCameraFullscreen_"]');
		const n = await pills.count();
		for (let i = 0; i < n; i++) {
			const b = await pills.nth(i).boundingBox();
			if (b && x >= b.x && x <= b.x + b.width) {
				await editor.mouse.click(x, b.y + b.height / 2);
				await sleep(500);
				return true;
			}
		}
		return false;
	};
	const shot = async (name) => {
		const file = path.join(OUT, `${name}.png`);
		await preview.screenshot({ path: file });
		return file;
	};
	const cameraPillCount = () =>
		editor.locator('[class*="_lanePill_"][class*="_laneCameraFullscreen_"]').count();
	return { time, seekTo, selectPillAt, shot, cameraPillCount };
}

const shots = [];
let exitCode = 0;
let session = null;
try {
	session = await launch();
	const { editor, preview } = session;
	const d = driver(editor, preview);
	const before = cameraState();
	note(
		"the copy opens with no layout sections",
		before.layouts.length === 0 && before.fulls.length === 1,
		`fulls ${brief(before.fulls)}`,
	);
	note("one camera-lane pill on open", (await d.cameraPillCount()) === 1);

	// A. Camera + inset from the layout menu, at 3 s.
	await d.seekTo(3);
	await editor.getByRole("button", { name: /^Add layout/ }).click();
	await editor.getByRole("button", { name: /Camera \+ inset/ }).click();
	let r = await waitState(
		(s) => s.layouts.length === 1 && s.layouts[0].template === "camera-full-pip",
	);
	note("A: the layout menu adds a camera-full-pip section", r.ok, brief(r.state.layouts));
	const sectionA = r.state.layouts[0];
	const midA = sectionA ? (sectionA.startMs + sectionA.endMs) / 2000 : 4;
	note(
		"A: its two places show the clip's two cameras",
		Boolean(sectionA) &&
			sectionA.slots.length === 2 &&
			new Set(sectionA.slots.map((s) => s.camera)).size === 2,
		JSON.stringify(sectionA?.slots),
	);
	const tA = await d.seekTo(midA);
	shots.push(await d.shot("A-camera-full-pip"));
	await editor.screenshot({ path: path.join(OUT, "A-window.png") });
	const boxes = await editor.evaluate(() => {
		const box = (el) => {
			const r = el?.getBoundingClientRect();
			return r ? [r.x, r.y, r.width, r.height].map(Math.round) : null;
		};
		const preview = document.querySelector('[data-testid="preview"]');
		return {
			window: [window.innerWidth, window.innerHeight],
			preview: box(preview),
			frame: box(preview?.querySelector('[class*="_previewFrame_"]')),
			canvas: box(preview?.querySelector("canvas")),
		};
	});
	fs.writeFileSync(path.join(OUT, "A-boxes.json"), JSON.stringify(boxes, null, 2));
	note("A: preview captured inside the section", Math.abs(tA - midA) < 0.3, `t=${tA.toFixed(2)}`);

	// B. Choose cameras in the inspector: camera 1 into the large place, then camera 2 again.
	note("B: the section is selectable on the timeline", await d.selectPillAt(midA));
	const place1 = editor.getByRole("combobox", { name: /^Place 1/ });
	await place1.waitFor({ state: "visible", timeout: 5000 });
	for (const camera of [0, 1]) {
		await place1.selectOption(String(camera));
		r = await waitState(
			(s) =>
				s.layouts.length === 1 &&
				s.layouts[0].slots[0].camera === camera &&
				s.layouts[0].slots[1].camera === 1 - camera,
		);
		note(
			`B: the inspector puts camera ${camera + 1} into place 1 (the other moves to place 2)`,
			r.ok,
			JSON.stringify(r.state.layouts[0]?.slots),
		);
		await sleep(1000);
		shots.push(await d.shot(`B-camera${camera + 1}-large`));
	}

	// C. A Full Camera section (key C) at 9 s, converted to screen + camera and back.
	await d.seekTo(9);
	await editor.keyboard.press("c");
	r = await waitState((s) => s.fulls.length === 2);
	note("C: key C adds a Full Camera section", r.ok, brief(r.state.fulls));
	const fullC = r.state.fulls.find((f) => f.startMs > 8000 && f.startMs < 10_000);
	const midC = fullC ? (fullC.startMs + fullC.endMs) / 2000 : 10;
	await d.seekTo(midC);
	shots.push(await d.shot("C1-full-camera"));
	note("C: the Full Camera section is selectable", await d.selectPillAt(midC));
	const templates = editor.getByRole("group", { name: "Layout" });
	await templates.getByRole("button", { name: /Screen \+ camera/ }).click();
	r = await waitState(
		(s) =>
			s.fulls.length === 1 &&
			s.layouts.length === 2 &&
			s.layouts.some((l) => l.template === "screen-pip" && Math.abs(l.startMs - fullC.startMs) < 1),
	);
	note(
		"C: Full Camera → screen-pip moves the section into the layout list",
		r.ok,
		brief(r.state.layouts),
	);
	await sleep(1000);
	shots.push(await d.shot("C2-screen-pip"));
	await templates.getByRole("button", { name: /^Full camera/ }).click();
	r = await waitState(
		(s) =>
			s.fulls.length === 2 &&
			s.layouts.length === 1 &&
			s.fulls.some((f) => Math.abs(f.startMs - fullC.startMs) < 1),
	);
	note("C: screen-pip → Full Camera moves it back", r.ok, `fulls ${brief(r.state.fulls)}`);
	await sleep(1000);
	shots.push(await d.shot("C3-full-camera-again"));

	// D. Undo and redo the conversion back.
	await editor.keyboard.press("Control+z");
	r = await waitState(
		(s) => s.fulls.length === 1 && s.layouts.some((l) => l.template === "screen-pip"),
	);
	note("D: Ctrl+Z restores the screen-pip section", r.ok, brief(r.state.layouts));
	await editor.keyboard.press("Control+Shift+z");
	r = await waitState((s) => s.fulls.length === 2 && s.layouts.length === 1);
	note("D: Ctrl+Shift+Z redoes the Full Camera", r.ok, `fulls ${brief(r.state.fulls)}`);

	// E. Drag the inset window of section A in the preview.
	await d.seekTo(midA);
	await d.selectPillAt(midA);
	const place = editor.getByTestId("layout-place").first();
	await place.waitFor({ state: "visible", timeout: 5000 });
	note(
		"E: the selected section shows its PiP window in the preview",
		true,
		`${await editor.getByTestId("layout-place").count()} place(s)`,
	);
	const pb = await place.boundingBox();
	const rectBefore = cameraState().layouts[0]?.slots[1]?.rect ?? null;
	await editor.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
	await editor.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await editor.mouse.move(pb.x + pb.width / 2 - 12 * i, pb.y + pb.height / 2 - 6 * i);
		await sleep(30);
	}
	await editor.mouse.up();
	r = await waitState((s) => {
		const rect = s.layouts[0]?.slots[1]?.rect;
		return Boolean(rect) && JSON.stringify(rect) !== JSON.stringify(rectBefore);
	});
	note(
		"E: dragging the PiP window stores its rect",
		r.ok,
		JSON.stringify(r.state.layouts[0]?.slots[1]?.rect),
	);
	await sleep(1000);
	shots.push(await d.shot("E-pip-dragged"));

	// F. Calibration: perspective of camera 2, from the camera list.
	await d.seekTo(midA); // the ruler click also clears the selection
	const rail = editor.getByRole("button", { name: "Camera layout", exact: true });
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	await editor
		.getByTestId("camera-row-1")
		.getByRole("button", { name: /Correct perspective/ })
		.click();
	const dialog = editor.getByRole("dialog");
	await dialog.waitFor({ state: "visible", timeout: 5000 });
	await dialog
		.getByText(/Loading the camera picture/)
		.waitFor({ state: "detached", timeout: 15_000 });
	note(
		"F: the dialog loads the camera still",
		!(await dialog.getByText(/could not be loaded/).count()),
	);
	await dialog.getByRole("button", { name: "Detect markers" }).click();
	const status = dialog.getByRole("status");
	const statusText = (await status.innerText()).trim();
	note("F: marker detection reports a result", statusText.length > 0, statusText);
	const h0 = dialog.getByTestId("calibration-handle-0");
	await h0.focus();
	for (let i = 0; i < 4; i++) await editor.keyboard.press("Shift+ArrowRight");
	for (let i = 0; i < 4; i++) await editor.keyboard.press("Shift+ArrowDown");
	note("F: moving a corner clears the marker message", (await status.innerText()).trim() === "");
	const h2 = await dialog.getByTestId("calibration-handle-2").boundingBox();
	await editor.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
	await editor.mouse.down();
	for (let i = 1; i <= 8; i++) {
		await editor.mouse.move(h2.x + h2.width / 2 - 5 * i, h2.y + h2.height / 2 - 3 * i);
		await sleep(30);
	}
	await editor.mouse.up();
	await sleep(500);
	await dialog.screenshot({ path: path.join(OUT, "F1-calibration-dialog.png") });
	shots.push(path.join(OUT, "F1-calibration-dialog.png"));
	await dialog.getByRole("button", { name: "Apply", exact: true }).click();
	r = await waitState((s) => {
		const p = s.settings?.[1]?.perspective;
		return Boolean(p) && p.corners.length === 4 && Math.abs(p.aspect - 297 / 210) < 1e-6;
	});
	const corners = r.state.settings?.[1]?.perspective?.corners;
	note(
		"F: Apply stores camera 2's perspective (A4 landscape)",
		r.ok && corners[0].x > 0.15 && corners[2].x < 0.85,
		JSON.stringify(r.state.settings?.[1]?.perspective),
	);
	await d.seekTo(midA);
	await sleep(1000);
	shots.push(await d.shot("F2-perspective-in-section"));

	// G. Save, relaunch, compare.
	await editor.keyboard.press("Control+s");
	await sleep(1500);
	const saved = cameraState();
	await close(session);
	session = null;

	session = await launch();
	const d2 = driver(session.editor, session.preview);
	const reopened = cameraState();
	note(
		"G: the reopened project keeps sections and camera settings",
		JSON.stringify(reopened) === JSON.stringify(saved),
		`${reopened.layouts.length} layout(s), ${reopened.fulls.length} full camera(s)`,
	);
	note("G: the timeline shows all three camera sections", (await d2.cameraPillCount()) === 3);
	await d2.seekTo(midA);
	shots.push(await d2.shot("G-reopened-section-A"));
	await d2.seekTo(midC);
	shots.push(await d2.shot("G-reopened-full-camera"));
	fs.writeFileSync(path.join(OUT, "final-state.json"), JSON.stringify(reopened, null, 2));
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
	fs.rmSync(COPY_FILE, { force: true });
	console.log(`removed copy: ${!fs.existsSync(COPY_FILE)}`);
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots }, null, 2));
	exitCode = results.every((x) => x.ok) ? 0 : 1;
}
process.exit(exitCode);
