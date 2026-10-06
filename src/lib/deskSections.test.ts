import { describe, expect, it } from "vitest";
import { deskRowsForScene, normalizeDeskRegions, resolveDeskCamera } from "./deskSections";

describe("normalizeDeskRegions", () => {
	it("keeps valid rows with their anchor, sorted, and drops broken or overlapping ones", () => {
		const rows = normalizeDeskRegions([
			{ id: "b", startMs: 5000, endMs: 7000, clipId: "c1", sourceStartSec: 5, sourceEndSec: 7 },
			{ id: "a", startMs: 1000, endMs: 3000, deskLabel: false },
			{ id: "x", startMs: 6000, endMs: 8000 },
			{ id: "bad", startMs: 4000, endMs: 4000 },
			{ startMs: 1, endMs: 2 },
			"nope",
		]);
		expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
		expect(rows[0].deskLabel).toBe(false);
		expect(rows[1]).toMatchObject({ clipId: "c1", sourceStartSec: 5, sourceEndSec: 7 });
	});

	it("reads nothing from a missing list", () => {
		expect(normalizeDeskRegions(undefined)).toEqual([]);
	});
});

describe("resolveDeskCamera", () => {
	const none = [{}, {}, {}];

	it("takes the chosen camera when the project has it", () => {
		expect(resolveDeskCamera({ deskCamera: 2, cameraCount: 3, cameraSettings: none })).toBe(2);
		expect(resolveDeskCamera({ deskCamera: 0, cameraCount: 3, cameraSettings: none })).toBe(0);
	});

	it("falls back to the first camera after camera 1 with a perspective", () => {
		const withPerspective = [
			{},
			{},
			{
				perspective: {
					corners: [
						{ x: 0, y: 0 },
						{ x: 1, y: 0 },
						{ x: 1, y: 1 },
						{ x: 0, y: 1 },
					],
					aspect: 1,
				},
			},
		] as never;
		expect(
			resolveDeskCamera({ deskCamera: undefined, cameraCount: 3, cameraSettings: withPerspective }),
		).toBe(2);
		// A chosen camera the project no longer has falls back the same way.
		expect(
			resolveDeskCamera({ deskCamera: 7, cameraCount: 3, cameraSettings: withPerspective }),
		).toBe(2);
	});

	it("falls back to camera 2, and to nothing with a single camera", () => {
		expect(
			resolveDeskCamera({ deskCamera: undefined, cameraCount: 2, cameraSettings: [{}, {}] }),
		).toBe(1);
		expect(
			resolveDeskCamera({ deskCamera: undefined, cameraCount: 1, cameraSettings: [{}] }),
		).toBeNull();
		expect(resolveDeskCamera({ deskCamera: "2", cameraCount: 1, cameraSettings: [{}] })).toBeNull();
	});
});

describe("deskRowsForScene", () => {
	const rows = normalizeDeskRegions([
		{
			id: "d1",
			startMs: 1000,
			endMs: 3000,
			clipId: "c1",
			assetId: "a1",
			sourceStartSec: 1,
			sourceEndSec: 3,
		},
	]);

	it("turns a section of camera k >= 2 into a camera-full layout row with the same anchor", () => {
		const out = deskRowsForScene(rows, 2);
		expect(out.full).toEqual([]);
		expect(out.layout).toEqual([
			{
				id: "d1",
				startMs: 1000,
				endMs: 3000,
				clipId: "c1",
				assetId: "a1",
				sourceStartSec: 1,
				sourceEndSec: 3,
				template: "camera-full",
				slots: [{ camera: 2 }],
			},
		]);
	});

	it("turns a section of camera 1 into a Full Camera row without an orientation override", () => {
		const out = deskRowsForScene(rows, 0);
		expect(out.layout).toEqual([]);
		expect(out.full).toEqual([
			{
				id: "d1",
				startMs: 1000,
				endMs: 3000,
				clipId: "c1",
				assetId: "a1",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		]);
	});

	it("draws nothing without a desk camera", () => {
		expect(deskRowsForScene(rows, null)).toEqual({ layout: [], full: [] });
	});
});
