import { describe, expect, it } from "vitest";
import type { CameraPerspective, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "@/lib/cameraPerspective";
import {
	cropAspectOf,
	cropLeavesImage,
	cropToPerspective,
	fitCrop,
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

	it("stops at the view's edge", () => {
		const r = resizeCropLocked(start, "se", 5, 5, 2, 16 / 9);
		expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
		expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
	});
});
