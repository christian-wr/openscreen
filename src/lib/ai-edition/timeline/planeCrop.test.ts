import { describe, expect, it } from "vitest";
import type { CameraPerspective, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "@/lib/cameraPerspective";
import { MIN_CROP } from "./calibrationGeometry";
import {
	cropAspectOf,
	cropLeavesImage,
	cropToPerspective,
	fitCrop,
	fitCropInside,
	PLANE_VIEW_GROW,
	perspectiveToCrop,
	planeView,
	resizeCropLocked,
} from "./planeCrop";

// Seen straight on: a 0.6 x 0.6 square of the image that is 2:1 in reality.
const FLAT: CameraPerspective = {
	corners: [
		{ x: 0.2, y: 0.2 },
		{ x: 0.8, y: 0.2 },
		{ x: 0.8, y: 0.8 },
		{ x: 0.2, y: 0.8 },
	],
	aspect: 2,
};

// A desk seen steeply: the far edge much narrower than the near one.
const STEEP: CameraPerspective = {
	corners: [
		{ x: 0.44, y: 0.3 },
		{ x: 0.56, y: 0.3 },
		{ x: 0.95, y: 0.95 },
		{ x: 0.05, y: 0.95 },
	],
	aspect: 1.5,
};

function close(a: CropRegion | null, b: CropRegion, digits = 6) {
	expect(a).not.toBeNull();
	expect(a?.x).toBeCloseTo(b.x, digits);
	expect(a?.y).toBeCloseTo(b.y, digits);
	expect(a?.width).toBeCloseTo(b.width, digits);
	expect(a?.height).toBeCloseTo(b.height, digits);
}

describe("planeView", () => {
	it("grows the base rectangle about its centre and keeps its real proportions", () => {
		const view = planeView(FLAT);
		expect(view?.aspect).toBe(2);
		expect(view?.corners[0].x).toBeCloseTo(0.2 - 0.3 * 0.6, 9);
		expect(view?.corners[2].y).toBeCloseTo(0.8 + 0.3 * 0.6, 9);
	});

	it("puts the base in the middle of the view", () => {
		const view = planeView(FLAT);
		const side = 1 / PLANE_VIEW_GROW;
		close(view && perspectiveToCrop(view, FLAT), {
			x: (1 - side) / 2,
			y: (1 - side) / 2,
			width: side,
			height: side,
		});
	});

	it("never reaches past the horizon of a steep view", () => {
		const view = planeView(STEEP, 4);
		const h = homographyFromUnitSquare(STEEP.corners);
		expect(view).not.toBeNull();
		expect(h).not.toBeNull();
		// Every view corner, taken back onto the base, sits in front of the camera.
		const box = view && perspectiveToCrop(view, STEEP);
		expect(box).not.toBeNull();
		if (!h || !box) return;
		// Proof that the view was pulled back: unshrunk, the base would fill only 1/4 of it.
		expect(box.width).toBeGreaterThan(1 / 4);
		const lo = -box.x / box.width;
		const hi = (1 - box.x) / box.width;
		for (const [u, v] of [
			[lo, lo],
			[hi, lo],
			[hi, hi],
			[lo, hi],
		]) {
			expect(h[6] * u + h[7] * v + h[8]).toBeGreaterThan(0);
		}
	});
});

describe("crop <-> perspective", () => {
	it("round-trips a crop", () => {
		const view = planeView(STEEP);
		const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.3 };
		const p = view && cropToPerspective(view, crop);
		close(view && p && perspectiveToCrop(view, p), crop);
	});

	it("gives the crop its real proportions", () => {
		const view = planeView(FLAT);
		const p = view && cropToPerspective(view, { x: 0.1, y: 0.1, width: 0.5, height: 0.25 });
		expect(p?.aspect).toBeCloseTo(4, 9);
		expect(cropAspectOf(2, { x: 0, y: 0, width: 0.5, height: 0.25 })).toBeCloseTo(4, 9);
	});

	it("notices a crop that leaves the camera image", () => {
		const view = planeView(FLAT);
		expect(
			cropLeavesImage(view && cropToPerspective(view, { x: 0, y: 0, width: 1, height: 1 })),
		).toBe(false);
		const wide = planeView(FLAT, 2);
		expect(
			cropLeavesImage(wide && cropToPerspective(wide, { x: 0, y: 0, width: 1, height: 1 })),
		).toBe(true);
	});
});

describe("fitCrop", () => {
	it("fits the largest crop of a real aspect into a box, centred", () => {
		// View 2:1; a 16:9 crop is k = 2 / (16/9) = 1.125 times as tall as wide in fractions.
		close(fitCrop(2, 16 / 9, { x: 0, y: 0, width: 1, height: 1 }), {
			x: (1 - 1 / 1.125) / 2,
			y: 0,
			width: 1 / 1.125,
			height: 1,
		});
	});

	it("keeps the box for a free format", () => {
		const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
		expect(fitCrop(2, null, box)).toEqual(box);
	});
});

type Quad = CameraPerspective["corners"];

/** Inside or on a convex quad, either winding. */
function inQuad(q: Quad, p: { x: number; y: number }, eps = 1e-9): boolean {
	const s = q.map((a, i) => {
		const b = q[(i + 1) % 4];
		return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	});
	return s.every((v) => v >= -eps) || s.every((v) => v <= eps);
}

function centroid(q: Quad) {
	return { x: q.reduce((t, p) => t + p.x, 0) / 4, y: q.reduce((t, p) => t + p.y, 0) / 4 };
}

/** `crop` grown by `f` about its own centre. */
function grownBy(crop: CropRegion, f: number): CropRegion {
	const cx = crop.x + crop.width / 2;
	const cy = crop.y + crop.height / 2;
	return {
		x: cx - (crop.width * f) / 2,
		y: cy - (crop.height * f) / 2,
		width: crop.width * f,
		height: crop.height * f,
	};
}

describe("fitCropInside", () => {
	// The inner corners as markers lie: no rectangle, inside FLAT's base.
	const TRAPEZOID: Quad = [
		{ x: 0.3, y: 0.2 },
		{ x: 0.8, y: 0.26 },
		{ x: 0.72, y: 0.8 },
		{ x: 0.2, y: 0.68 },
	];

	function check(base: CameraPerspective, quad: Quad, aspect: number | null) {
		const view = planeView(base);
		const box = view && perspectiveToCrop(view, base);
		expect(view).not.toBeNull();
		expect(box).not.toBeNull();
		if (!view || !box) throw new Error("unusable test base");
		const crop = fitCropInside(view, aspect, box, quad);
		const p = cropToPerspective(view, crop);
		expect(p).not.toBeNull();
		if (!p) throw new Error("no perspective");
		for (const c of p.corners) {
			expect(inQuad(quad, c, 1e-6)).toBe(true);
			expect(c.x).toBeGreaterThanOrEqual(-1e-9);
			expect(c.y).toBeGreaterThanOrEqual(-1e-9);
			expect(c.x).toBeLessThanOrEqual(1 + 1e-9);
			expect(c.y).toBeLessThanOrEqual(1 + 1e-9);
		}
		// Centred on the inner corners' centroid.
		const mid = centroid(quad);
		const at = perspectiveToCrop(view, { corners: [mid, mid, mid, mid], aspect: 1 });
		expect(crop.x + crop.width / 2).toBeCloseTo(at?.x ?? Number.NaN, 6);
		expect(crop.y + crop.height / 2).toBeCloseTo(at?.y ?? Number.NaN, 6);
		// As large as it can be: a little more and a corner leaves the quad or the image.
		const larger = cropToPerspective(view, grownBy(crop, 1.01));
		expect(
			larger?.corners.some((c) => !inQuad(quad, c) || c.x < 0 || c.y < 0 || c.x > 1 || c.y > 1),
		).toBe(true);
		return { crop, p, box, view };
	}

	it("puts the largest 16:9 crop inside a quad that is not a rectangle", () => {
		const { p } = check(FLAT, TRAPEZOID, 16 / 9);
		expect(p.aspect).toBeCloseTo(16 / 9, 9);
	});

	it("does the same on a steep desk", () => {
		const quad: Quad = [
			{ x: 0.45, y: 0.33 },
			{ x: 0.55, y: 0.31 },
			{ x: 0.9, y: 0.93 },
			{ x: 0.1, y: 0.9 },
		];
		const { p } = check(STEEP, quad, 4 / 3);
		expect(p.aspect).toBeCloseTo(4 / 3, 9);
	});

	it("keeps the crop in the camera image where the quad is not", () => {
		const base: CameraPerspective = {
			corners: [
				{ x: -0.3, y: 0.1 },
				{ x: 0.9, y: 0.1 },
				{ x: 0.9, y: 0.9 },
				{ x: -0.3, y: 0.9 },
			],
			aspect: 1.5,
		};
		const quad: Quad = [
			{ x: -0.3, y: 0.1 },
			{ x: 0.9, y: 0.1 },
			{ x: 0.9, y: 0.9 },
			{ x: -0.3, y: 0.9 },
		];
		const { p } = check(base, quad, 16 / 9);
		expect(Math.min(...p.corners.map((c) => c.x))).toBeGreaterThan(-1e-6);
	});

	it("keeps the box's shape for a free format", () => {
		const { crop, box } = check(FLAT, TRAPEZOID, null);
		expect(crop.width / crop.height).toBeCloseTo(box.width / box.height, 9);
	});
});

describe("resizeCropLocked", () => {
	const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 * 1.125 };

	it("keeps the aspect and the opposite corner", () => {
		const r = resizeCropLocked(start, "se", 0.1, 0, 2, 16 / 9);
		expect(r.x).toBeCloseTo(0.2, 9);
		expect(r.y).toBeCloseTo(0.2, 9);
		expect(r.width).toBeCloseTo(0.5, 9);
		expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
	});

	it("follows the axis the pointer moved further along", () => {
		const r = resizeCropLocked(start, "nw", 0, -0.2, 2, 16 / 9);
		expect(r.x + r.width).toBeCloseTo(0.6, 9);
		expect(r.y + r.height).toBeCloseTo(0.2 + 0.45, 9);
		expect(r.height).toBeCloseTo(0.45 + 0.2, 9);
	});

	// Outward movement of each corner, in view fractions: (dx, dy) signs that grow the crop.
	const OUT: Record<"nw" | "ne" | "sw" | "se", [number, number]> = {
		nw: [-1, -1],
		ne: [1, -1],
		sw: [-1, 1],
		se: [1, 1],
	};
	const anchorOf = (r: { x: number; y: number; width: number; height: number }, c: string) => ({
		x: c.endsWith("e") ? r.x : r.x + r.width,
		y: c.startsWith("s") ? r.y : r.y + r.height,
	});

	for (const corner of ["nw", "ne", "sw", "se"] as const) {
		const [sx, sy] = OUT[corner];
		for (const [label, sign] of [
			["grows", 1],
			["shrinks", -1],
		] as const) {
			for (const axis of ["x", "y"] as const) {
				it(`${label} from ${corner} along ${axis}, aspect and anchor held`, () => {
					const d = 0.05 * sign;
					const r =
						axis === "x"
							? resizeCropLocked(start, corner, sx * d, 0, 2, 16 / 9)
							: resizeCropLocked(start, corner, 0, sy * d, 2, 16 / 9);
					const expected = axis === "x" ? start.width + d : start.width + d / 1.125;
					expect(r.width).toBeCloseTo(expected, 9);
					expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
					const a = anchorOf(r, corner);
					const a0 = anchorOf(start, corner);
					expect(a.x).toBeCloseTo(a0.x, 9);
					expect(a.y).toBeCloseTo(a0.y, 9);
				});
			}
		}
	}

	it("shrinks no further than the smallest crop", () => {
		const r = resizeCropLocked(start, "se", -5, 0, 2, 16 / 9);
		expect(r.width).toBeCloseTo(Math.max(MIN_CROP, MIN_CROP / 1.125), 9);
		expect(r.height).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
		expect(r.x).toBeCloseTo(0.2, 9);
		expect(r.y).toBeCloseTo(0.2, 9);
	});

	it("stops at the view's edge", () => {
		const r = resizeCropLocked(start, "se", 5, 5, 2, 16 / 9);
		expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
		expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
	});
});
