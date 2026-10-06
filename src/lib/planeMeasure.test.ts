import { describe, expect, it } from "vitest";
import type { CameraPerspective } from "@/components/video-editor/types";
import { markerPlaneRect } from "./planeMeasure";

type Corners = CameraPerspective["corners"];
interface Pt {
	x: number;
	y: number;
}

// A camera looking at the desk at a slant: world millimetres -> image pixels.
const H = [1.1, 0.25, 420, 0.04, 0.8, 180, 0.0003, 0.0008, 1];

function project(m: number[], p: Pt): Pt {
	const w = m[6] * p.x + m[7] * p.y + m[8];
	return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

function inverse(m: number[]): number[] {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		A / det,
		(c * h - b * i) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		(c * d - a * f) / det,
		C / det,
		(b * g - a * h) / det,
		(a * e - b * d) / det,
	];
}

/** A 40 mm square centred on `c`, turned by `deg`, corners clockwise from its top-left. */
function square(c: Pt, deg: number): Pt[] {
	const r = (deg * Math.PI) / 180;
	return [
		{ x: -20, y: -20 },
		{ x: 20, y: -20 },
		{ x: 20, y: 20 },
		{ x: -20, y: 20 },
	].map((p) => ({
		x: c.x + p.x * Math.cos(r) - p.y * Math.sin(r),
		y: c.y + p.x * Math.sin(r) + p.y * Math.cos(r),
	}));
}

/** The square's corner nearest to `toward`. */
function nearest(sq: Pt[], toward: Pt): Pt {
	return sq.reduce((best, p) =>
		Math.hypot(p.x - toward.x, p.y - toward.y) < Math.hypot(best.x - toward.x, best.y - toward.y)
			? p
			: best,
	);
}

function angleAt(a: Pt, b: Pt, c: Pt): number {
	const u = { x: a.x - b.x, y: a.y - b.y };
	const v = { x: c.x - b.x, y: c.y - b.y };
	return (
		(Math.acos((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))) * 180) /
		Math.PI
	);
}

// Markers laid freely: no rectangle, each turned its own way (the user's real desk).
const CENTERS: Pt[] = [
	{ x: 0, y: 0 },
	{ x: 620, y: -40 },
	{ x: 560, y: 430 },
	{ x: -90, y: 300 },
];
const TURNS = [5, -12, 30, 80];
const WORLD_SQUARES = CENTERS.map((c, i) => square(c, TURNS[i]));
const MIDDLE = {
	x: CENTERS.reduce((s, c) => s + c.x, 0) / 4,
	y: CENTERS.reduce((s, c) => s + c.y, 0) / 4,
};
const WORLD_INNER = WORLD_SQUARES.map((sq) => nearest(sq, MIDDLE));

const toImage = (pts: Pt[]) => pts.map((p) => project(H, p)) as Corners;

describe("markerPlaneRect", () => {
	const rect = markerPlaneRect(WORLD_SQUARES.map(toImage), 40, toImage(WORLD_INNER) as Corners);
	const world = rect ? rect.corners.map((p) => project(inverse(H), p)) : [];

	it("is a true rectangle on the desk although the markers are not", () => {
		expect(rect).not.toBeNull();
		for (let k = 0; k < 4; k++) {
			expect(angleAt(world[(k + 3) % 4], world[k], world[(k + 1) % 4])).toBeCloseTo(90, 0);
		}
	});

	it("reports the real width and proportions", () => {
		const width = Math.hypot(world[1].x - world[0].x, world[1].y - world[0].y);
		const height = Math.hypot(world[3].x - world[0].x, world[3].y - world[0].y);
		expect(Math.abs((rect?.widthMm ?? 0) - width) / width).toBeLessThan(0.005);
		expect(Math.abs((rect?.aspect ?? 0) - width / height) / (width / height)).toBeLessThan(0.005);
	});

	it("gives nothing without squares", () => {
		expect(markerPlaneRect([], 40, toImage(WORLD_INNER) as Corners)).toBeNull();
	});
});

/** Angle between two directions as lines, in degrees, 0..90. */
function lineAngleDeg(a: number, b: number): number {
	const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
	return (Math.min(d, Math.PI - d) * 180) / Math.PI;
}

/** The markers turned by `deg` about their middle, as world squares and inner corners. */
function turned(deg: number) {
	const r = (deg * Math.PI) / 180;
	const centers = CENTERS.map((c) => ({
		x: MIDDLE.x + (c.x - MIDDLE.x) * Math.cos(r) - (c.y - MIDDLE.y) * Math.sin(r),
		y: MIDDLE.y + (c.x - MIDDLE.x) * Math.sin(r) + (c.y - MIDDLE.y) * Math.cos(r),
	}));
	const squares = centers.map((c, i) => square(c, TURNS[i] + deg));
	return { squares, inner: squares.map((sq) => nearest(sq, MIDDLE)) };
}

describe("markerPlaneRect levels the frame to the camera", () => {
	// `cam` maps world -> image; the image may be mirrored.
	function run(cam: number[]) {
		const back = inverse(cam);
		const img = (pts: Pt[]) => pts.map((p) => project(cam, p)) as Corners;
		// The camera's horizontal at the markers' middle, as a world direction.
		const horizontalAt = (inner: Pt[]) => {
			const a = img(inner).reduce((t, p) => ({ x: t.x + p.x / 4, y: t.y + p.y / 4 }), {
				x: 0,
				y: 0,
			});
			const p0 = project(back, a);
			const p1 = project(back, { x: a.x + 1, y: a.y });
			return Math.atan2(p1.y - p0.y, p1.x - p0.x);
		};
		const along = (inner: Pt[]) => Math.atan2(inner[1].y - inner[0].y, inner[1].x - inner[0].x);
		// Turn the markers so that 0 -> 1 runs 20 degrees off the camera's horizontal.
		const first = turned(0);
		const { squares, inner } = turned(
			((horizontalAt(first.inner) - along(first.inner)) * 180) / Math.PI + 20,
		);
		const horizontal = horizontalAt(inner);
		const rect = markerPlaneRect(squares.map(img), 40, img(inner));
		expect(rect).not.toBeNull();
		const world = rect ? rect.corners.map((p) => project(back, p)) : [];
		return { inner, horizontal, world, markers: along(inner) };
	}

	for (const [name, cam] of [
		["a plain camera", H],
		// The same camera seen in a mirror: x flips in the image.
		[
			"a mirrored image",
			[-H[0] + 2000 * H[6], -H[1] + 2000 * H[7], -H[2] + 2000 * H[8], ...H.slice(3)],
		],
	] as const) {
		it(`keeps the top edge level with ${name}, marker 0 at the top-left`, () => {
			const { inner, horizontal, world, markers } = run([...cam]);
			// The setup really tilts the markers against the camera.
			expect(lineAngleDeg(markers, horizontal)).toBeGreaterThan(15);
			expect(lineAngleDeg(markers, horizontal)).toBeLessThan(25);
			const top = Math.atan2(world[1].y - world[0].y, world[1].x - world[0].x);
			expect(lineAngleDeg(top, horizontal)).toBeLessThan(0.5);
			for (let k = 0; k < 4; k++) {
				expect(angleAt(world[(k + 3) % 4], world[k], world[(k + 1) % 4])).toBeCloseTo(90, 0);
			}
			const d = inner.map((p) => Math.hypot(p.x - world[0].x, p.y - world[0].y));
			expect(d.indexOf(Math.min(...d))).toBe(0);
		});
	}
});
