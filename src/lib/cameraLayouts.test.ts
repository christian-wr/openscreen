import { describe, expect, it } from "vitest";
import {
	cameraSectionsOverlapping,
	fullCameraRowsOfLayoutList,
	isFullCameraLayout,
	MAX_CAMERAS,
	normalizeCameraLayoutRegions,
	normalizeCameraSettings,
	patchCameraSettings,
} from "./cameraLayouts";

const base = { id: "a", startMs: 0, endMs: 1000 };
const persp = {
	corners: [
		{ x: 0.1, y: 0.1 },
		{ x: 0.9, y: 0.1 },
		{ x: 0.9, y: 0.9 },
		{ x: 0.1, y: 0.9 },
	],
	aspect: 1.5,
};

describe("normalizeCameraLayoutRegions", () => {
	it("round-trips a valid region", () => {
		const region = {
			...base,
			template: "side-by-side",
			slots: [{ camera: 0 }, { camera: 1, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }],
		};
		expect(normalizeCameraLayoutRegions([region])).toEqual([region]);
	});
	it("returns [] for non-arrays and drops non-objects", () => {
		expect(normalizeCameraLayoutRegions("x")).toEqual([]);
		expect(normalizeCameraLayoutRegions([null, 3, "s"])).toEqual([]);
	});
	it("drops an unknown template", () => {
		expect(
			normalizeCameraLayoutRegions([{ ...base, template: "grid", slots: [{ camera: 0 }] }]),
		).toEqual([]);
	});
	it("removes a duplicate camera from slots (first wins)", () => {
		const out = normalizeCameraLayoutRegions([
			{ ...base, template: "screen-pip", slots: [{ camera: 1 }, { camera: 1 }, { camera: 2 }] },
		]);
		expect(out[0].slots).toEqual([{ camera: 1 }, { camera: 2 }]);
	});
	it("drops out-of-range cameras and clamps to the template maximum", () => {
		const out = normalizeCameraLayoutRegions([
			{
				...base,
				template: "side-by-side",
				slots: [{ camera: MAX_CAMERAS }, { camera: 0 }, { camera: 1 }, { camera: 2 }],
			},
		]);
		expect(out[0].slots).toEqual([{ camera: 0 }, { camera: 1 }]);
	});
	it("drops camera-full-pip with a single slot", () => {
		expect(
			normalizeCameraLayoutRegions([
				{ ...base, template: "camera-full-pip", slots: [{ camera: 0 }] },
			]),
		).toEqual([]);
	});
	it("drops a region whose end is not after its start", () => {
		expect(
			normalizeCameraLayoutRegions([
				{ ...base, endMs: 0, template: "camera-full", slots: [{ camera: 1 }] },
			]),
		).toEqual([]);
	});
	it("sorts by start and drops the later of two overlapping regions", () => {
		const mk = (id: string, startMs: number, endMs: number) => ({
			id,
			startMs,
			endMs,
			template: "camera-full",
			slots: [{ camera: 1 }],
		});
		const out = normalizeCameraLayoutRegions([
			mk("c", 1000, 2000),
			mk("b", 500, 1500),
			mk("a", 0, 1000),
		]);
		expect(out.map((r) => r.id)).toEqual(["a", "c"]);
	});
	it("removes a rect containing NaN but keeps the slot", () => {
		const out = normalizeCameraLayoutRegions([
			{
				...base,
				template: "screen-pip",
				slots: [{ camera: 1, rect: { x: Number.NaN, y: 0, width: 0.2, height: 0.2 } }],
			},
		]);
		expect(out[0].slots).toEqual([{ camera: 1 }]);
	});
	it("removes a rect with non-positive size or outside the allowed range", () => {
		const out = normalizeCameraLayoutRegions([
			{
				...base,
				template: "screen-pip",
				slots: [
					{ camera: 1, rect: { x: 0, y: 0, width: 0, height: 0.2 } },
					{ camera: 2, rect: { x: 2, y: 0, width: 0.2, height: 0.2 } },
				],
			},
		]);
		expect(out[0].slots).toEqual([{ camera: 1 }, { camera: 2 }]);
	});
	it("strips desk fields from a non camera-full template", () => {
		const out = normalizeCameraLayoutRegions([
			{
				...base,
				template: "screen-pip",
				slots: [{ camera: 1 }],
				rotation: 180,
				mirror: "on",
				deskLabel: false,
			},
		]);
		expect(out[0]).toEqual({ ...base, template: "screen-pip", slots: [{ camera: 1 }] });
	});
	it("strips desk fields from a camera-full region of another camera", () => {
		const out = normalizeCameraLayoutRegions([
			{
				...base,
				template: "camera-full",
				slots: [{ camera: 2 }],
				rotation: 180,
				mirror: "on",
				deskLabel: false,
			},
		]);
		expect(out[0]).toEqual({ ...base, template: "camera-full", slots: [{ camera: 2 }] });
	});
	it("keeps the clip anchor fields", () => {
		const anchor = { clipId: "clip-a", assetId: "asset-a", sourceStartSec: 4, sourceEndSec: 5 };
		const out = normalizeCameraLayoutRegions([
			{ ...base, ...anchor, template: "screen-pip", slots: [{ camera: 1 }] },
			{
				...base,
				id: "b",
				startMs: 2000,
				endMs: 3000,
				clipId: 7,
				sourceStartSec: Number.NaN,
				template: "screen-pip",
				slots: [{ camera: 1 }],
			},
		]);
		expect(out[0]).toEqual({ ...base, ...anchor, template: "screen-pip", slots: [{ camera: 1 }] });
		expect(out[1]).toEqual({
			id: "b",
			startMs: 2000,
			endMs: 3000,
			template: "screen-pip",
			slots: [{ camera: 1 }],
		});
	});
	it("drops a camera-full row for camera 1 (it belongs to full camera)", () => {
		const out = normalizeCameraLayoutRegions([
			{ ...base, template: "camera-full", slots: [{ camera: 0 }] },
			{ ...base, id: "b", template: "camera-full", slots: [{ camera: 1 }] },
		]);
		expect(out.map((r) => r.id)).toEqual(["b"]);
	});
});

describe("isFullCameraLayout", () => {
	it("is true only for camera-full with camera 1", () => {
		expect(isFullCameraLayout({ template: "camera-full", slots: [{ camera: 0 }] })).toBe(true);
		expect(isFullCameraLayout({ template: "camera-full", slots: [{ camera: 1 }] })).toBe(false);
		expect(isFullCameraLayout({ template: "screen-pip", slots: [{ camera: 0 }] })).toBe(false);
	});

	it("is false for a camera-full row that names more than one camera", () => {
		expect(
			isFullCameraLayout({ template: "camera-full", slots: [{ camera: 0 }, { camera: 1 }] }),
		).toBe(false);
	});
});

describe("fullCameraRowsOfLayoutList", () => {
	it("keeps normalized desk fields on a camera-1 camera-full row", () => {
		const out = fullCameraRowsOfLayoutList([
			{
				...base,
				template: "camera-full",
				slots: [{ camera: 0 }],
				rotation: 180,
				mirror: "on",
				deskLabel: false,
			},
			{ ...base, id: "b", template: "screen-pip", slots: [{ camera: 0 }] },
		]);
		expect(out).toEqual([
			{
				...base,
				template: "camera-full",
				slots: [{ camera: 0 }],
				rotation: 180,
				mirror: "on",
				deskLabel: false,
			},
		]);
	});
});

describe("normalizeCameraSettings", () => {
	it("returns [] for non-arrays", () => {
		expect(normalizeCameraSettings(undefined)).toEqual([]);
	});
	it("clamps to four entries, maps junk to null and keeps valid settings", () => {
		const out = normalizeCameraSettings([
			null,
			{ rotation: 180, perspective: persp },
			"junk",
			{ mirror: true },
			{ rotation: 180 },
		]);
		expect(out).toEqual([null, { rotation: 180, perspective: persp }, null, { mirror: true }]);
	});
	it("removes a perspective with aspect 0", () => {
		expect(
			normalizeCameraSettings([{ rotation: 180, perspective: { ...persp, aspect: 0 } }]),
		).toEqual([{ rotation: 180 }]);
	});
	it("removes a perspective with a corner outside the range or non-finite", () => {
		const bad = { ...persp, corners: [{ x: 3, y: 0 }, ...persp.corners.slice(1)] };
		const nan = { ...persp, corners: [{ x: Number.NaN, y: 0 }, ...persp.corners.slice(1)] };
		expect(normalizeCameraSettings([{ perspective: bad }, { perspective: nan }])).toEqual([{}, {}]);
	});
	it("clamps the perspective margin to [0, 0.2]", () => {
		const out = normalizeCameraSettings([
			{ perspective: { ...persp, margin: 0.9 } },
			{ perspective: { ...persp, margin: -1 } },
		]);
		expect(out[0]?.perspective?.margin).toBe(0.2);
		expect(out[1]?.perspective?.margin).toBe(0);
	});
	it("keeps a finite crop and drops an invalid one", () => {
		const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
		expect(normalizeCameraSettings([{ crop }, { crop: { ...crop, width: 0 } }])).toEqual([
			{ crop },
			{},
		]);
	});
});

describe("patchCameraSettings", () => {
	it("an out-of-range index leaves the list alone", () => {
		expect(patchCameraSettings([null, { mirror: true }], MAX_CAMERAS, { mirror: true })).toEqual([
			null,
			{ mirror: true },
		]);
		expect(patchCameraSettings(undefined, -1, { mirror: true })).toBeUndefined();
		expect(patchCameraSettings(undefined, 1.5, { mirror: true })).toBeUndefined();
	});

	it("trims trailing nulls but keeps a middle hole", () => {
		const raw = [null, { mirror: true }, null, { rotation: 180 }];
		expect(patchCameraSettings(raw, 3, null)).toEqual([null, { mirror: true }]);
		expect(patchCameraSettings(raw, 1, null)).toEqual([null, null, null, { rotation: 180 }]);
	});

	it("undefined clears a key", () => {
		const raw = [null, { mirror: true, rotation: 180 }];
		expect(patchCameraSettings(raw, 1, { mirror: undefined })).toEqual([null, { rotation: 180 }]);
	});

	it("drops defaults", () => {
		expect(patchCameraSettings(undefined, 1, { rotation: 0, mirror: false })).toBeUndefined();
		expect(patchCameraSettings([null, { mirror: true }], 1, { mirror: false })).toBeUndefined();
	});

	it("null resets a middle camera", () => {
		const raw = [null, { mirror: true }, { rotation: 180 }];
		expect(patchCameraSettings(raw, 1, null)).toEqual([null, null, { rotation: 180 }]);
	});

	// The main camera's rotation, mirror and crop are the layout pane's fields; every other
	// camera, camera 1 included once it is not the main one, keeps its own here.
	it("keeps only the perspective of the main camera", () => {
		expect(patchCameraSettings(undefined, 0, { mirror: true })).toBeUndefined();
		expect(patchCameraSettings(undefined, 0, { mirror: true }, 2)).toEqual([{ mirror: true }]);
		expect(patchCameraSettings(undefined, 2, { rotation: 180 }, 2)).toBeUndefined();
		expect(patchCameraSettings(undefined, 1, { rotation: 180 }, 2)).toEqual([
			null,
			{ rotation: 180 },
		]);
	});
});

describe("cameraSectionsOverlapping", () => {
	const rows = [
		{ id: "a", startMs: 1000, endMs: 2000 },
		{ id: "b", startMs: 3000, endMs: 4000 },
	];

	it("returns every row the span overlaps", () => {
		expect(cameraSectionsOverlapping(rows, 1500, 3500).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("does not count touching as overlap", () => {
		expect(cameraSectionsOverlapping(rows, 2000, 3000)).toEqual([]);
		expect(cameraSectionsOverlapping(rows, 0, 1000)).toEqual([]);
	});

	it("finds a row the span lies inside", () => {
		expect(cameraSectionsOverlapping(rows, 3200, 3300).map((r) => r.id)).toEqual(["b"]);
	});
});
