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

	it("runs along marker 0 -> marker 1 and keeps marker 0 at the top-left", () => {
		const along = Math.atan2(world[1].y - world[0].y, world[1].x - world[0].x);
		const markers = Math.atan2(
			WORLD_INNER[1].y - WORLD_INNER[0].y,
			WORLD_INNER[1].x - WORLD_INNER[0].x,
		);
		expect(Math.abs(along - markers)).toBeLessThan(0.01);
		// The rectangle is the hull of the inner corners: marker 0's corner lies on its top edge
		// side, so the top-left is nearer to it than to any other inner corner.
		const d = WORLD_INNER.map((p) => Math.hypot(p.x - world[0].x, p.y - world[0].y));
		expect(d.indexOf(Math.min(...d))).toBe(0);
	});

	it("gives nothing without squares", () => {
		expect(markerPlaneRect([], 40, toImage(WORLD_INNER) as Corners)).toBeNull();
	});
});
