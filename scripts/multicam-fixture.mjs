// Several cameras in the picture, measured end to end (dev tool, not part of the build).
//
// Generates synthetic sources and two projects, runs the real headless export, and checks the
// exported pixels against the camera layout templates and the glide the compositor plans.
//
//   node scripts/multicam-fixture.mjs generate <dir>
//       screen.mp4 (1920x1080 dark grey, 8 s), cam0.mp4 (solid red), cam1.mp4 (solid green),
//       cam2.mp4 (a 16x9 checkerboard warped "in perspective" onto known corners), all
//       1280x720, plus multicam.openscreen (three cameras, four layout regions, a perspective
//       on camera 2) and onecam.openscreen (the same take with camera 1 only, no regions).
//       Also board43.mp4 (a 12x9 board, 4:3, warped onto the same corners) and two more
//       projects: persp.openscreen (camera 1 IS that board with a 4:3 perspective, in its
//       default PiP and then in a Full Camera section) and seam.openscreen (a camera-1 Full
//       Camera section directly followed by a camera-full-pip [2, 1] layout region).
//   node scripts/multicam-fixture.mjs export <project.openscreen> <out.mp4>
//       Runs `electron . export` and prints the wall-clock time. Run from a built tree
//       (`npm run build-vite`) with OPENSCREEN_COMPOSITOR_VIEW_NODE pointing at the addon and
//       its ffmpeg DLLs first on PATH.
//   node scripts/multicam-fixture.mjs check <out.mp4> [multicam|persp|seam]
//       Extracts frames by index and prints a pass/fail table; exits 1 on any failure.
//       The project defaults to multicam.
//
// The expected rects (`pipRect`, `regionLayers`, `plannedRects`) MIRROR the templates and
// the planner; they are not an independent derivation. The template PiPs anchor on camera
// 1's default PiP, which the check measures (red box at 0.5 s) instead of recomputing it.
//
// ffmpeg: OPENSCREEN_FFMPEG, else the vendored build under crates/thirdparty.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG =
	process.env.OPENSCREEN_FFMPEG ??
	path.join(ROOT, "crates", "thirdparty", "ffmpeg-n8.1.2-win64-lgpl-shared", "bin", "ffmpeg.exe");

const DURATION_S = 8;
const CAM_W = 1280;
const CAM_H = 720;
const SQUARE_PX = 80; // 16 x 9 squares on the 1280x720 board
// Where the board's corners land in camera 2's picture (pixels): TL, TR, BR, BL.
const BOARD_CORNERS_PX = [
	[160, 90],
	[1050, 40],
	[1180, 680],
	[70, 600],
];
const BOARD_ASPECT = CAM_W / CAM_H;
// Camera 1's board in persp.openscreen: 12 x 9 squares, so its corrected picture is 4:3 while
// the camera's own frame is 16:9 — a box laid out from the raw camera would stretch it.
const BOARD43 = { cols: 12, rows: 9, aspect: 4 / 3 };

// Mirrors src/lib/cameraLayoutTemplates.ts.
const PIP_WIDTH_FRAC = 0.22;
const PIP_MARGIN_FRAC = 0.025;
const PIP_GAP_FRAC = 0.02;
// Mirrors crates/compositor/src/regions.rs.
const TRANSITION_WINDOW_S = 1.01505;
const FULLSCREEN_LEAD_OUT_WINDOW_S = TRANSITION_WINDOW_S * 1.5;
const EXPORT_FPS = 60;
const TOLERANCE_PX = 2;

const PERSP_REGIONS = [
	{ id: "lay_persp_full", startMs: 3000, endMs: 6000, template: "camera-full", cameras: [0] },
];
const SEAM_REGIONS = [
	{ id: "lay_seam_full", startMs: 1000, endMs: 3000, template: "camera-full", cameras: [0] },
	{ id: "lay_seam_pip", startMs: 3000, endMs: 5000, template: "camera-full-pip", cameras: [1, 0] },
];

const REGIONS = [
	{ id: "lay_screen_pip", startMs: 1000, endMs: 3000, template: "screen-pip", cameras: [0, 1] },
	{ id: "lay_full_pip", startMs: 3000, endMs: 5000, template: "camera-full-pip", cameras: [1, 0] },
	{ id: "lay_side", startMs: 5500, endMs: 7000, template: "side-by-side", cameras: [0, 1] },
	{ id: "lay_board", startMs: 7000, endMs: 8000, template: "camera-full", cameras: [2] },
];

function run(cmd, args) {
	const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
	if (result.status !== 0) {
		throw new Error(
			`${path.basename(cmd)} failed (${result.status}): ${result.stderr?.slice(-2000)}`,
		);
	}
	return result;
}

function encode(input, filter, out) {
	run(FFMPEG, [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		input,
		...(filter ? ["-vf", filter] : []),
		"-t",
		String(DURATION_S),
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libopenh264",
		"-b:v",
		"12M",
		out,
	]);
}

/** Unit square (0,0),(1,0),(1,1),(0,1) onto four points (Heckbert), as `cameraPerspective.ts`. */
function homographyFromUnitSquare([p0, p1, p2, p3]) {
	const dx1 = p1[0] - p2[0];
	const dx2 = p3[0] - p2[0];
	const dx3 = p0[0] - p1[0] + p2[0] - p3[0];
	const dy1 = p1[1] - p2[1];
	const dy2 = p3[1] - p2[1];
	const dy3 = p0[1] - p1[1] + p2[1] - p3[1];
	const den = dx1 * dy2 - dx2 * dy1;
	const g = (dx3 * dy2 - dx2 * dy3) / den;
	const h = (dx1 * dy3 - dx3 * dy1) / den;
	return [
		p1[0] - p0[0] + g * p1[0],
		p3[0] - p0[0] + h * p3[0],
		p0[0],
		p1[1] - p0[1] + g * p1[1],
		p3[1] - p0[1] + h * p3[1],
		p0[1],
		g,
		h,
		1,
	];
}

function invert3([a, b, c, d, e, f, g, h, i]) {
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	return [
		(e * i - f * h) / det,
		(c * h - b * i) / det,
		(b * f - c * e) / det,
		(f * g - d * i) / det,
		(a * i - c * g) / det,
		(c * d - a * f) / det,
		(d * h - e * g) / det,
		(b * g - a * h) / det,
		(a * e - b * d) / det,
	];
}

function generate(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const media = {
		screen: path.join(dir, "screen.mp4"),
		cam0: path.join(dir, "cam0.mp4"),
		cam1: path.join(dir, "cam1.mp4"),
		cam2: path.join(dir, "cam2.mp4"),
	};
	encode(`color=c=0x303030:s=1920x1080:r=30:d=${DURATION_S}`, null, media.screen);
	encode(`color=c=red:s=${CAM_W}x${CAM_H}:r=30:d=${DURATION_S}`, null, media.cam0);
	encode(`color=c=0x00ff00:s=${CAM_W}x${CAM_H}:r=30:d=${DURATION_S}`, null, media.cam1);
	// ffmpeg's `perspective` filter is GPL-only, and the vendored build is LGPL: the board is
	// drawn straight in perspective instead. Each output pixel centre is mapped back onto the
	// board's unit square by the inverse homography, so the true corners are exact.
	const inv = invert3(homographyFromUnitSquare(BOARD_CORNERS_PX));
	const [s, u, w] = [0, 3, 6].map((r) => `(${inv[r]}*(X+0.5)+${inv[r + 1]}*(Y+0.5)+${inv[r + 2]})`);
	const board = (cols, rows) =>
		`geq=lum='st(0,${s}/${w});st(1,${u}/${w});` +
		`if(lt(ld(0),0)+gte(ld(0),1)+lt(ld(1),0)+gte(ld(1),1),128,` +
		`if(mod(floor(ld(0)*${cols})+floor(ld(1)*${rows}),2),235,16))':cb=128:cr=128`;
	const black = `color=c=black:s=${CAM_W}x${CAM_H}:r=30:d=${DURATION_S},format=yuv420p`;
	encode(black, board(CAM_W / SQUARE_PX, CAM_H / SQUARE_PX), media.cam2);
	media.board43 = path.join(dir, "board43.mp4");
	encode(black, board(BOARD43.cols, BOARD43.rows), media.board43);

	const track = (sourcePath, label) => ({
		sourcePath,
		startMs: 0,
		offsetMs: 0,
		visible: true,
		width: CAM_W,
		height: CAM_H,
		...(label === undefined ? {} : { label }),
	});
	const corners = BOARD_CORNERS_PX.map(([x, y]) => ({ x: x / CAM_W, y: y / CAM_H }));
	const slotted = (regions) =>
		regions.map(({ cameras, ...region }) => ({
			...region,
			slots: cameras.map((camera) => ({ camera })),
		}));
	// kind: "multicam" | "onecam" | "persp" | "seam".
	const project = (kind) => ({
		schemaVersion: 8,
		project: {
			id: `proj_${kind}_fixture`,
			title: `${kind} fixture`,
			createdAt: "2026-10-05T00:00:00.000Z",
			updatedAt: "2026-10-05T00:00:00.000Z",
			primaryAssetId: "asset_screen",
		},
		assets: [
			{
				id: "asset_screen",
				kind: "video",
				label: "screen.mp4",
				originalPath: media.screen,
				durationSec: DURATION_S,
				sizeBytes: fs.statSync(media.screen).size,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 30 },
				cameraTrack: track(kind === "persp" ? media.board43 : media.cam0),
				...(kind === "multicam"
					? {
							additionalCameraTracks: [track(media.cam1, "Green"), track(media.cam2, "Board")],
						}
					: {}),
				...(kind === "seam" ? { additionalCameraTracks: [track(media.cam1, "Green")] } : {}),
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_main",
					assetId: "asset_screen",
					sourceStartSec: 0,
					sourceEndSec: DURATION_S,
					timelineStartSec: 0,
					timelineEndSec: DURATION_S,
					wordRefs: [],
					origin: "user",
					reason: "Fixture",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: {
			wallpaper: "#101010",
			wallpaperMotion: "none",
			frame: "none",
			shadowIntensity: 0,
			backgroundBlur: 0,
			motionBlurAmount: 0,
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "rectangle",
			webcamRoundness: 0.1,
			webcamBackgroundMode: "none",
			...(kind === "multicam"
				? {
						cameraLayoutRegions: slotted(REGIONS),
						cameraSettings: [null, null, { perspective: { corners, aspect: BOARD_ASPECT } }],
					}
				: {}),
			...(kind === "persp"
				? {
						cameraLayoutRegions: slotted(PERSP_REGIONS),
						cameraSettings: [{ perspective: { corners, aspect: BOARD43.aspect } }],
					}
				: {}),
			...(kind === "seam" ? { cameraLayoutRegions: slotted(SEAM_REGIONS) } : {}),
		},
	});
	for (const kind of ["multicam", "onecam", "persp", "seam"]) {
		const file = path.join(dir, `${kind}.openscreen`);
		fs.writeFileSync(file, `${JSON.stringify(project(kind), null, 2)}\n`);
		console.log(`wrote ${file}`);
	}
}

/**
 * Runs the headless export and prints its wall-clock time, and the render time alone: from
 * the first progress line to "Exported", which leaves Electron's start-up and the project
 * load out.
 */
function exportProject(projectPath, outPath) {
	const electron = createRequire(import.meta.url)("electron");
	const started = performance.now();
	let firstProgress = null;
	let exported = null;
	const child = spawn(electron, [ROOT, "export", projectPath, "-o", outPath], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const watch = (chunk, sink) => {
		const text = chunk.toString();
		if (firstProgress === null && text.includes("Exporting")) firstProgress = performance.now();
		if (exported === null && text.includes("Exported")) exported = performance.now();
		sink.write(text);
	};
	child.stdout.on("data", (chunk) => watch(chunk, process.stdout));
	child.stderr.on("data", (chunk) => watch(chunk, process.stderr));
	child.once("exit", (code) => {
		const seconds = (performance.now() - started) / 1000;
		const render =
			firstProgress !== null && exported !== null
				? `${((exported - firstProgress) / 1000).toFixed(2)} s`
				: "unknown";
		console.log(`export exit=${code} wall=${seconds.toFixed(2)} s render=${render}`);
		process.exitCode = code ?? 1;
	});
}

// --- checking ---------------------------------------------------------------------------

/** Minimal P6 reader: {width, height, data} with 3 bytes per pixel. */
function readPpm(file) {
	const buf = fs.readFileSync(file);
	const fields = [];
	let i = 0;
	while (fields.length < 4) {
		while (/\s/.test(String.fromCharCode(buf[i]))) i++;
		if (buf[i] === 0x23) {
			while (buf[i] !== 0x0a) i++;
			continue;
		}
		let token = "";
		while (!/\s/.test(String.fromCharCode(buf[i]))) token += String.fromCharCode(buf[i++]);
		fields.push(token);
	}
	if (fields[0] !== "P6" || fields[3] !== "255") throw new Error(`${file}: not an 8-bit P6`);
	return { width: Number(fields[1]), height: Number(fields[2]), data: buf.subarray(i + 1) };
}

/** One ffmpeg pass that writes the given frame indices as PPMs, in order. */
function extractFrames(video, indices, dir) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const select = indices.map((n) => `eq(n\\,${n})`).join("+");
	run(FFMPEG, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		video,
		"-vf",
		`select='${select}'`,
		"-fps_mode",
		"passthrough",
		"-c:v",
		"ppm",
		path.join(dir, "f%04d.ppm"),
	]);
	return new Map(
		indices.map((n, k) => [n, readPpm(path.join(dir, `f${String(k + 1).padStart(4, "0")}.ppm`))]),
	);
}

const isRed = (r, g, b) => r > 150 && g < 100 && b < 100;
const isGreen = (r, g, b) => g > 150 && r < 100 && b < 100;

/** Bounding box [x0, y0, x1, y1) of the pixels `test` accepts, and how many there are. */
function bbox(frame, test) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -1;
	let y1 = -1;
	let count = 0;
	const { width, height, data } = frame;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 3;
			if (!test(data[o], data[o + 1], data[o + 2])) continue;
			count++;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	}
	return count === 0 ? null : { box: [x0, y0, x1 + 1, y1 + 1], count };
}

/**
 * A template PiP of a 16:9 camera, like `pipLayer`: anchored on camera 1's default PiP
 * (`anchor`, [x, y, w, h] fractions: its width, right and bottom edges), stacking leftwards;
 * the corner constants without one.
 */
function pipRect(index, frame, anchor) {
	const w = anchor ? anchor[2] : PIP_WIDTH_FRAC;
	const h = (w * frame.width) / (16 / 9) / frame.height;
	const firstRight = anchor ? anchor[0] + anchor[2] : 1 - PIP_MARGIN_FRAC;
	const right = firstRight - index * (w + PIP_GAP_FRAC);
	const bottom = anchor
		? anchor[1] + anchor[3]
		: 1 - (PIP_MARGIN_FRAC * frame.width) / frame.height;
	return [right - w, bottom - h, w, h];
}

/** Each region's layers as {camera: [x, y, w, h]} (fractions), like `resolveCameraLayout`. */
function regionLayers(region, frame, anchor) {
	const out = {};
	region.cameras.forEach((camera, i) => {
		if (region.template === "camera-full" || (region.template === "camera-full-pip" && i === 0)) {
			out[camera] = [0, 0, 1, 1];
		} else if (region.template === "side-by-side") {
			out[camera] = i === 0 ? [0, 0, 0.5, 1] : [0.5, 0, 0.5, 1];
		} else {
			out[camera] = pipRect(region.template === "camera-full-pip" ? i - 1 : i, frame, anchor);
		}
	});
	return out;
}

function cubicBezier(x1, y1, x2, y2, x) {
	const sample = (a, b, t) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (sample(x1, x2, mid) < x) lo = mid;
		else hi = mid;
	}
	return sample(y1, y2, (lo + hi) / 2);
}
const ease = (t) => cubicBezier(0.16, 1, 0.3, 1, Math.min(1, Math.max(0, t)));

/**
 * The rect each camera is planned at, at source time t: `camera_layers_at` in
 * crates/compositor/src/camera_layers.rs for these regions (no speed regions, so the screen
 * clock is the source clock). `fallback` is camera 0's default rect outside every region.
 * Opacity is ignored: the check only looks at where a camera is.
 */
function plannedRects(t, frame, fallback, regions = REGIONS) {
	const sec = (ms) => ms / 1000;
	// A camera-1 camera-full region is a Full Camera section, not a layout region; it is a
	// layout region's neighbour only at a seam, with camera 1 on the whole frame.
	const isFullCamera = (r) => r.template === "camera-full" && r.cameras[0] === 0;
	const layouts = regions.filter((r) => !isFullCamera(r));
	const index = layouts.findIndex((r) => sec(r.startMs) <= t && t <= sec(r.endMs));
	const fallbackLayers = { 0: fallback };
	if (index < 0) return fallbackLayers;
	const region = layouts[index];
	const [start, end] = [sec(region.startMs), sec(region.endMs)];
	const prev = regions.find((r) => r !== region && Math.abs(sec(r.endMs) - start) <= 0.001);
	const hasNext = regions.some((r) => r !== region && Math.abs(sec(r.startMs) - end) <= 0.001);
	const current = regionLayers(region, frame, fallback);
	const half = (end - start) / 2;
	const winIn = Math.min(TRANSITION_WINDOW_S, half);
	const winOut = Math.min(FULLSCREEN_LEAD_OUT_WINDOW_S, half);
	const blend = (from, to, k) => {
		const out = {};
		for (const [camera, rect] of Object.entries(to)) {
			const a = from[camera];
			out[camera] = a ? rect.map((v, i) => a[i] + (v - a[i]) * k) : rect;
		}
		for (const [camera, rect] of Object.entries(from)) out[camera] ??= rect;
		return out;
	};
	if (t - start < winIn) {
		return blend(
			prev ? regionLayers(prev, frame, fallback) : fallbackLayers,
			current,
			ease((t - start) / winIn),
		);
	}
	if (!hasNext && end - t < winOut) {
		return blend(current, fallbackLayers, 1 - ease((end - t) / winOut));
	}
	return current;
}

const toPx = ([x, y, w, h], frame) => [
	x * frame.width,
	y * frame.height,
	(x + w) * frame.width,
	(y + h) * frame.height,
];
/** Largest edge distance (px) between a measured box and a planned rect. */
function boxError(measured, rect, frame) {
	if (!measured) return Infinity;
	const want = toPx(rect, frame);
	return Math.max(...measured.box.map((v, i) => Math.abs(v - want[i])));
}
const fmtBox = (m) => (m ? `[${m.box.join(", ")}]` : "none");
const fmtRect = (rect, frame) =>
	`[${toPx(rect, frame)
		.map((v) => v.toFixed(1))
		.join(", ")}]`;

/** Sub-pixel positions where the luminance along a line crosses mid-grey. */
function edgesAlong(frame, horizontal, at) {
	const { width, height, data } = frame;
	const n = horizontal ? width : height;
	const lum = (i) => {
		const o = horizontal ? (at * width + i) * 3 : (i * width + at) * 3;
		return (data[o] + data[o + 1] + data[o + 2]) / 3;
	};
	const edges = [];
	for (let i = 1; i < n; i++) {
		const a = lum(i - 1) - 128;
		const b = lum(i) - 128;
		if (a < 0 !== b < 0) edges.push(i - 1 + a / (a - b) + 0.5);
	}
	return edges;
}

/**
 * The rectified board, cover-fitted into the frame like any other camera: squares of one size
 * `s = max(W / cols, H / rows)`, centred, so its edges sit at `centre + k * s` on both axes.
 * Checks three rows and three columns: edges where the square grid puts them (right angles and
 * equal square sizes), and equally spaced within each line.
 */
function boardCheck(frame, cols = CAM_W / SQUARE_PX, rows = CAM_H / SQUARE_PX) {
	const { width, height } = frame;
	const size = Math.max(width / cols, height / rows);
	const along = (centre, count, extent) => {
		const out = [];
		for (let k = -count; k <= count; k++) {
			const e = centre + (k - count / 2) * size;
			if (e > 3 && e < extent - 3) out.push(e);
		}
		return out;
	};
	const lines = [
		...[1, 4, 7].map((r) => ({
			horizontal: true,
			at: Math.round(height / 2 + (r - rows / 2 + 0.5) * size),
			want: along(width / 2, cols, width),
		})),
		...[2, Math.floor(cols / 2), cols - 3].map((c) => ({
			horizontal: false,
			at: Math.round(width / 2 + (c - cols / 2 + 0.5) * size),
			want: along(height / 2, rows, height),
		})),
	];
	let spacingError = 0;
	let gridError = 0;
	const found = [];
	const steps = { horizontal: [], vertical: [] };
	for (const line of lines) {
		const edges = edgesAlong(frame, line.horizontal, line.at);
		found.push(`${edges.length}/${line.want.length}`);
		if (edges.length < 2) {
			spacingError = Infinity;
			gridError = Infinity;
			continue;
		}
		const step = (edges[edges.length - 1] - edges[0]) / (edges.length - 1);
		steps[line.horizontal ? "horizontal" : "vertical"].push(step);
		edges.forEach((e, k) => {
			spacingError = Math.max(spacingError, Math.abs(e - (edges[0] + k * step)));
		});
		if (edges.length !== line.want.length) {
			gridError = Infinity;
			continue;
		}
		edges.forEach((e, k) => {
			gridError = Math.max(gridError, Math.abs(e - line.want[k]));
		});
	}
	const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
	return {
		lines: lines.length,
		found,
		size,
		spacingError,
		gridError,
		stepH: mean(steps.horizontal),
		stepV: mean(steps.vertical),
	};
}

function report(rows) {
	for (const r of rows) {
		const verdict = r.pass === null ? "INFO" : r.pass ? "PASS" : "FAIL";
		console.log(`${verdict} | ${r.name} | ${r.measured} | expected ${r.expected}`);
	}
	const checked = rows.filter((r) => r.pass !== null);
	const failed = checked.filter((r) => !r.pass).length;
	console.log(`${checked.length - failed}/${checked.length} passed`);
	process.exitCode = failed === 0 ? 0 : 1;
}

const fractionsOf = (found, frame) =>
	found
		? [
				found.box[0] / frame.width,
				found.box[1] / frame.height,
				(found.box[2] - found.box[0]) / frame.width,
				(found.box[3] - found.box[1]) / frame.height,
			]
		: null;

const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;

/**
 * The board inside a box (`box` = [x0, y0, x1, y1) px): the mean square step across (from
 * three rows) and down (from three columns), from the luminance edges strictly inside it.
 */
function boardInBox(frame, box, cols, rows) {
	const [x0, y0, x1, y1] = box;
	const { width, data } = frame;
	const lum = (x, y) => {
		const o = (y * width + x) * 3;
		return (data[o] + data[o + 1] + data[o + 2]) / 3 - 128;
	};
	const edges = (horizontal, at) => {
		const out = [];
		const [lo, hi] = horizontal ? [x0 + 3, x1 - 3] : [y0 + 3, y1 - 3];
		for (let i = lo + 1; i < hi; i++) {
			const a = horizontal ? lum(i - 1, at) : lum(at, i - 1);
			const b = horizontal ? lum(i, at) : lum(at, i);
			if (a < 0 !== b < 0) out.push(i - 1 + a / (a - b) + 0.5);
		}
		return out;
	};
	const step = (e) => (e.length < 2 ? Number.NaN : (e[e.length - 1] - e[0]) / (e.length - 1));
	const [bw, bh] = [x1 - x0, y1 - y0];
	const across = [1, Math.floor(rows / 2), rows - 2].map((r) =>
		step(edges(true, Math.round(y0 + ((r + 0.5) * bh) / rows))),
	);
	const down = [2, Math.floor(cols / 2), cols - 3].map((c) =>
		step(edges(false, Math.round(x0 + ((c + 0.5) * bw) / cols))),
	);
	const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
	return { stepH: mean(across), stepV: mean(down) };
}

function checkPersp(video) {
	const frameAt = (sec) => Math.round(sec * EXPORT_FPS);
	const frames = extractFrames(
		video,
		[frameAt(1), frameAt(4.25)],
		path.join(os.tmpdir(), "openscreen-multicam-frames"),
	);
	const rows = [];
	const add = (name, pass, measured, expected) => rows.push({ name, pass, measured, expected });
	const { cols, rows: boardRows, aspect } = BOARD43;

	// Default PiP: the box takes the perspective's 4:3, and its squares are square.
	const pipFrame = frames.get(frameAt(1));
	const pip = bbox(pipFrame, isWhite);
	const pipAspect = pip ? (pip.box[2] - pip.box[0]) / (pip.box[3] - pip.box[1]) : Number.NaN;
	const pipHeight = pip ? pip.box[3] - pip.box[1] : 0;
	add(
		"1.0 s camera 1 PiP box has the perspective's 4:3",
		Math.abs(pipAspect * pipHeight - aspect * pipHeight) <= TOLERANCE_PX,
		`${fmtBox(pip)} ratio ${pipAspect.toFixed(4)}`,
		`${aspect.toFixed(4)} within ${TOLERANCE_PX} px of width`,
	);
	const inPip = pip ? boardInBox(pipFrame, pip.box, cols, boardRows) : { stepH: NaN, stepV: NaN };
	add(
		"1.0 s PiP checkerboard squares square (step across vs down)",
		Math.abs(inPip.stepH - inPip.stepV) <= TOLERANCE_PX,
		`${inPip.stepH.toFixed(2)} x ${inPip.stepV.toFixed(2)} px`,
		`equal within ${TOLERANCE_PX} px`,
	);

	// Full Camera: the 4:3 picture cover-fitted into the frame, squares square and on the grid.
	const board = boardCheck(frames.get(frameAt(4.25)), cols, boardRows);
	add(
		"4.25 s Full Camera checkerboard edges equally spaced",
		board.spacingError <= TOLERANCE_PX,
		`${board.lines} lines, edges ${board.found.join(" ")}, max err ${board.spacingError.toFixed(2)} px`,
		`<= ${TOLERANCE_PX} px`,
	);
	add(
		"4.25 s Full Camera checkerboard squares square (step across vs down)",
		Math.abs(board.stepH - board.stepV) <= TOLERANCE_PX,
		`${board.stepH.toFixed(2)} x ${board.stepV.toFixed(2)} px`,
		`equal within ${TOLERANCE_PX} px`,
	);
	add(
		"4.25 s Full Camera checkerboard on the cover-fitted square grid",
		board.gridError <= TOLERANCE_PX,
		`max err ${board.gridError.toFixed(2)} px`,
		`squares of ${board.size.toFixed(1)} px, centred`,
	);
	report(rows);
}

function checkSeam(video) {
	const t = (n) => n / EXPORT_FPS;
	const frameAt = (sec) => Math.round(sec * EXPORT_FPS);
	const sweep = [];
	// From after the Full Camera section's own lead-in (1.0 s + 1.015 s) across the seam.
	for (let n = frameAt(2.05); n <= frameAt(4.2); n += EXPORT_FPS / 30) sweep.push(n);
	const indices = [...new Set([frameAt(0.5), frameAt(4.6), ...sweep])].sort((a, b) => a - b);
	const frames = extractFrames(
		video,
		indices,
		path.join(os.tmpdir(), "openscreen-multicam-frames"),
	);
	const rows = [];
	const add = (name, pass, measured, expected) => rows.push({ name, pass, measured, expected });
	const f05 = frames.get(frameAt(0.5));
	const fallback = fractionsOf(bbox(f05, isRed), f05);
	add("0.5 s camera 1 default PiP present", !!fallback, fmtBox(bbox(f05, isRed)), "red box");

	// Up to the seam camera 1 fills the frame: no lead-out of the Full Camera section.
	let notFull = 0;
	let worstFull = 0;
	// From the seam on, camera 1 is on the planned glide from the frame to its PiP slot, and
	// its box only ever shrinks: it never passes through the default PiP and back. (The slot
	// IS the default PiP's rect — template PiPs anchor on it — so where it ends proves
	// nothing; where the glide starts does.)
	let worstGlide = 0;
	let grows = 0;
	let lastArea = Infinity;
	let firstAfterSeam = null;
	const trace = [];
	for (const n of sweep) {
		const frame = frames.get(n);
		const got = bbox(frame, isRed);
		const area = got ? (got.box[2] - got.box[0]) * (got.box[3] - got.box[1]) : 0;
		trace.push(`${t(n).toFixed(2)}:${got ? got.box[0] : "-"}`);
		if (t(n) < 3) {
			const err = boxError(got, [0, 0, 1, 1], frame);
			worstFull = Math.max(worstFull, err);
			if (err > TOLERANCE_PX) notFull++;
		} else {
			const want = plannedRects(t(n), frame, fallback, SEAM_REGIONS)[0];
			worstGlide = Math.max(worstGlide, boxError(got, want, frame));
			if (area > lastArea + 4 * frame.width) grows++;
			if (t(n) > 3 && firstAfterSeam === null) firstAfterSeam = { n, got, width: frame.width };
		}
		lastArea = t(n) >= 3 ? area : lastArea;
	}
	add(
		"2.05-3.0 s camera 1 fills the frame up to the seam",
		notFull === 0,
		`${notFull} frames off, max err ${worstFull.toFixed(2)} px`,
		`0 (<= ${TOLERANCE_PX} px)`,
	);
	add(
		"3.0-4.2 s camera 1 on the planned glide from the frame",
		worstGlide <= TOLERANCE_PX,
		`max err ${worstGlide.toFixed(2)} px; left edge ${trace.filter((_, k) => k % 6 === 0).join(" ")}`,
		`<= ${TOLERANCE_PX} px`,
	);
	add("3.0-4.2 s camera 1 box never grows back", grows === 0, `${grows} growing steps`, "0");
	{
		// The first frame after the seam is barely into the glide: still nearly the whole frame.
		// Gliding from the default PiP instead, it would already be PiP-sized.
		const first = firstAfterSeam;
		const w = first?.got ? first.got.box[2] - first.got.box[0] : 0;
		add(
			`${first ? t(first.n).toFixed(3) : "?"} s glide starts from the frame, not the default PiP`,
			!!first && w >= 0.75 * first.width,
			first ? `${fmtBox(first.got)} width ${w} px` : "no frame",
			`>= ${first ? (0.75 * first.width).toFixed(0) : "?"} px wide`,
		);
	}
	const f46 = frames.get(frameAt(4.6));
	const slot = plannedRects(t(frameAt(4.6)), f46, fallback, SEAM_REGIONS);
	const red = bbox(f46, isRed);
	const redErr = boxError(red, slot[0], f46);
	add(
		"4.6 s camera 1 in its PiP slot",
		redErr <= TOLERANCE_PX,
		`${fmtBox(red)} err ${redErr.toFixed(2)} px`,
		fmtRect(slot[0], f46),
	);
	const green = bbox(f46, isGreen);
	add(
		"4.6 s camera 2 fills the frame under it",
		boxError(green, [0, 0, 1, 1], f46) <= TOLERANCE_PX,
		fmtBox(green),
		fmtRect([0, 0, 1, 1], f46),
	);
	report(rows);
}

function check(video) {
	const t = (n) => n / EXPORT_FPS;
	const frameAt = (sec) => Math.round(sec * EXPORT_FPS);
	const glide = [];
	for (let n = frameAt(2.9); n <= frameAt(3.6); n += EXPORT_FPS / 30) glide.push(n);
	const indices = [
		...new Set([
			frameAt(0.5),
			frameAt(2),
			frameAt(4),
			frameAt(6),
			frameAt(6.5),
			frameAt(7.5),
			...glide,
		]),
	].sort((a, b) => a - b);
	const frames = extractFrames(
		video,
		indices,
		path.join(os.tmpdir(), "openscreen-multicam-frames"),
	);
	const rows = [];
	const add = (name, pass, measured, expected) => rows.push({ name, pass, measured, expected });

	const f05 = frames.get(frameAt(0.5));
	const fallbackBox = bbox(f05, isRed);
	const fallback = fallbackBox
		? [
				fallbackBox.box[0] / f05.width,
				fallbackBox.box[1] / f05.height,
				(fallbackBox.box[2] - fallbackBox.box[0]) / f05.width,
				(fallbackBox.box[3] - fallbackBox.box[1]) / f05.height,
			]
		: null;
	add(
		"0.5 s camera 1 default PiP present (reference for 6.0 s)",
		!!fallbackBox,
		fmtBox(fallbackBox),
		"red box",
	);
	add("0.5 s no other camera", !bbox(f05, isGreen), fmtBox(bbox(f05, isGreen)), "no green");

	const atRect = (sec, camera, test, label) => {
		const frame = frames.get(frameAt(sec));
		const want = plannedRects(t(frameAt(sec)), frame, fallback)[camera];
		const got = bbox(frame, test);
		const err = boxError(got, want, frame);
		add(
			`${sec.toFixed(1)} s ${label}`,
			err <= TOLERANCE_PX,
			`${fmtBox(got)} err ${err.toFixed(2)} px`,
			fmtRect(want, frame),
		);
	};
	atRect(2, 0, isRed, "red PiP (screen-pip slot 0)");
	atRect(2, 1, isGreen, "green PiP (screen-pip slot 1)");
	atRect(4, 1, isGreen, "green fills the frame (camera-full-pip)");
	atRect(4, 0, isRed, "red PiP over it");

	// The glide across 3.0 s: green present in every frame, on the planned rect, and growing.
	let worst = 0;
	let missing = 0;
	let shrinks = 0;
	let lastArea = 0;
	const trace = [];
	for (const n of glide) {
		const frame = frames.get(n);
		const got = bbox(frame, isGreen);
		if (!got || got.count < 1000) missing++;
		const want = plannedRects(t(n), frame, fallback)[1];
		worst = Math.max(worst, boxError(got, want, frame));
		const area = got ? (got.box[2] - got.box[0]) * (got.box[3] - got.box[1]) : 0;
		if (area + 4 * frame.width < lastArea) shrinks++;
		lastArea = area;
		trace.push(`${t(n).toFixed(3)}:${got ? got.box[0] : "-"}`);
	}
	add(
		`2.9-3.6 s green present in all ${glide.length} frames`,
		missing === 0,
		`${missing} without green`,
		"0",
	);
	add(
		"2.9-3.6 s green on the planned glide rect",
		worst <= TOLERANCE_PX,
		`max err ${worst.toFixed(2)} px`,
		`<= ${TOLERANCE_PX} px`,
	);
	add("2.9-3.6 s green box never shrinks", shrinks === 0, `${shrinks} shrinking steps`, "0");
	const firstMoving = glide.find((n) => t(n) > 3);
	const lastGlide = glide[glide.length - 1];
	const k0 = plannedRects(t(firstMoving), frames.get(firstMoving), fallback)[1];
	add(
		"2.9-3.6 s glide starts at the 3.0 s boundary",
		boxError(
			bbox(frames.get(frameAt(2.9)), isGreen),
			pipRect(1, frames.get(frameAt(2.9)), fallback),
			frames.get(frameAt(2.9)),
		) <= TOLERANCE_PX && k0[0] < pipRect(1, frames.get(firstMoving), fallback)[0],
		`left edge ${trace.slice(0, 6).join(" ")} ... ${trace[trace.length - 1]}`,
		`PiP until 3.0, then x -> 0 (by ${t(lastGlide).toFixed(2)} s planned x ${(plannedRects(t(lastGlide), frames.get(lastGlide), fallback)[1][0] * frames.get(lastGlide).width).toFixed(1)})`,
	);

	{
		// Green (slot 1) is drawn after red, so it hides whatever of red's still-gliding rect
		// overhangs the right half: red's visible right edge is green's left edge.
		const frame = frames.get(frameAt(6));
		const planned = plannedRects(t(frameAt(6)), frame, fallback);
		const [x, y, w, h] = planned[0];
		const visible = [x, y, Math.min(x + w, planned[1][0]) - x, h];
		const got = bbox(frame, isRed);
		const err = boxError(got, visible, frame);
		add(
			"6.0 s red, left half (lead-in from the default, k = ease(2/3)), under green",
			err <= TOLERANCE_PX,
			`${fmtBox(got)} err ${err.toFixed(2)} px`,
			fmtRect(visible, frame),
		);
		const settled = boxError(got, [0, 0, 0.5, 1], frame);
		add("6.0 s red vs the settled left half", null, `err ${settled.toFixed(2)} px`, "information");
	}
	atRect(6, 1, isGreen, "green, right half (fading in)");
	atRect(6.5, 0, isRed, "red, settled left half");
	atRect(6.5, 1, isGreen, "green, settled right half");

	const board = boardCheck(frames.get(frameAt(7.5)));
	add(
		"7.5 s checkerboard edges equally spaced",
		board.spacingError <= TOLERANCE_PX,
		`${board.lines} lines, edges ${board.found.join(" ")}, max err ${board.spacingError.toFixed(2)} px`,
		`<= ${TOLERANCE_PX} px`,
	);
	add(
		"7.5 s checkerboard squares square (step across vs down)",
		Math.abs(board.stepH - board.stepV) <= TOLERANCE_PX,
		`${board.stepH.toFixed(2)} x ${board.stepV.toFixed(2)} px`,
		`equal within ${TOLERANCE_PX} px`,
	);
	add(
		"7.5 s checkerboard on the cover-fitted square grid",
		board.gridError <= TOLERANCE_PX,
		`max err ${board.gridError.toFixed(2)} px`,
		`squares of ${board.size.toFixed(1)} px, centred`,
	);

	report(rows);
}

const [command, a, b] = process.argv.slice(2);
if (command === "generate" && a) generate(path.resolve(a));
else if (command === "export" && a && b) exportProject(path.resolve(a), path.resolve(b));
else if (command === "check" && a && (b ?? "multicam") === "multicam") check(path.resolve(a));
else if (command === "check" && a && b === "persp") checkPersp(path.resolve(a));
else if (command === "check" && a && b === "seam") checkSeam(path.resolve(a));
else {
	console.error(
		"usage: multicam-fixture.mjs generate <dir> | export <project> <out.mp4> | check <out.mp4> [multicam|persp|seam]",
	);
	process.exitCode = 2;
}
