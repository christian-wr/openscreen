import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutDocument } from "./ai-edition/schema";
import { mainCameraOf, resolveMainCamera, sceneCameraIndex, withMainCamera } from "./mainCamera";

const track = (path: string, label = "") => ({
	sourcePath: path,
	startMs: 0,
	offsetMs: 0,
	visible: true,
	label,
});

const asset = (over: Partial<AxcutAsset> = {}): AxcutAsset =>
	({
		id: "a1",
		kind: "video",
		label: "a",
		originalPath: "/screen.mp4",
		cameraTrack: { sourcePath: "/c1.mp4", startMs: 0, offsetMs: 0, visible: true, width: 1920 },
		additionalCameraTracks: [track("/c2.mp4", "Desk"), track("/c3.mp4", "Brio")],
		...over,
	}) as AxcutAsset;

const doc = (legacy: Record<string, unknown> | null, assets: AxcutAsset[] = [asset()]) =>
	({ assets, legacyEditor: legacy }) as unknown as AxcutDocument;

const legacyOf = (d: AxcutDocument) => d.legacyEditor as Record<string, unknown>;

const perspective = (aspect: number) => ({
	corners: [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	],
	aspect,
});

describe("resolveMainCamera", () => {
	const available = (i: number) => i !== 1;

	it("returns the chosen camera when it is in range and available", () => {
		expect(resolveMainCamera({ mainCamera: 2, cameraCount: 3, available })).toBe(2);
	});

	it("falls back to camera 1 out of range", () => {
		expect(resolveMainCamera({ mainCamera: 3, cameraCount: 3, available })).toBe(0);
		expect(resolveMainCamera({ mainCamera: -1, cameraCount: 3, available })).toBe(0);
	});

	it("falls back to camera 1 when the chosen camera is unavailable", () => {
		expect(resolveMainCamera({ mainCamera: 1, cameraCount: 3, available })).toBe(0);
	});

	it("falls back to camera 1 when missing or not an integer", () => {
		expect(resolveMainCamera({ mainCamera: undefined, cameraCount: 3, available })).toBe(0);
		expect(resolveMainCamera({ mainCamera: 1.5, cameraCount: 3, available })).toBe(0);
		expect(resolveMainCamera({ mainCamera: "2", cameraCount: 3, available })).toBe(0);
	});
});

describe("mainCameraOf / sceneCameraIndex", () => {
	it("settles the document's main camera like the scene", () => {
		expect(mainCameraOf(doc({ mainCamera: 2 }))).toBe(2);
		expect(mainCameraOf(doc({ mainCamera: 5 }))).toBe(0);
		expect(mainCameraOf(doc(null))).toBe(0);
	});

	it("trades camera 1 and the main camera, leaving the others", () => {
		expect([0, 1, 2, 3].map((i) => sceneCameraIndex(i, 2))).toEqual([2, 1, 0, 3]);
		expect([0, 1].map((i) => sceneCameraIndex(i, 0))).toEqual([0, 1]);
	});
});

describe("withMainCamera", () => {
	it("returns the same document without a main camera", () => {
		const d = doc({ deskCamera: 1 });
		expect(withMainCamera(d)).toBe(d);
		const none = doc(null);
		expect(withMainCamera(none)).toBe(none);
	});

	it("returns the same document when the main camera is unavailable", () => {
		const hidden = asset({
			additionalCameraTracks: [track("/c2.mp4"), { ...track("/c3.mp4"), visible: false }],
		});
		const d = doc({ mainCamera: 2 }, [hidden]);
		expect(withMainCamera(d)).toBe(d);
	});

	// Camera 1's own rotation, mirror and crop are stored while another camera is the main
	// one; with camera 1 back in the main role the layout pane's fields drive it again.
	it("keeps only camera 1's perspective while camera 1 is the main camera", () => {
		const out = withMainCamera(
			doc({ cameraSettings: [{ mirror: true, perspective: perspective(1) }, { rotation: 180 }] }),
		);
		expect(legacyOf(out).cameraSettings).toEqual([
			{ perspective: perspective(1) },
			{ rotation: 180 },
		]);
		const lost = asset({
			additionalCameraTracks: [track("/c2.mp4"), { ...track("/c3.mp4"), visible: false }],
		});
		const fallback = withMainCamera(
			doc({ mainCamera: 2, cameraSettings: [{ rotation: 180 }, { mirror: true }] }, [lost]),
		);
		expect(legacyOf(fallback).cameraSettings).toEqual([null, { mirror: true }]);
		expect(legacyOf(fallback).mainCamera).toBe(2);
	});

	it("swaps the tracks of camera 1 and the main camera", () => {
		const out = withMainCamera(doc({ mainCamera: 2 }));
		const a = out.assets[0];
		expect(a.cameraTrack?.sourcePath).toBe("/c3.mp4");
		expect(a.additionalCameraTracks?.[1]?.sourcePath).toBe("/c1.mp4");
		expect(a.additionalCameraTracks?.[0]?.sourcePath).toBe("/c2.mp4");
		expect(legacyOf(out).mainCamera).toBeUndefined();
	});

	it("leaves an asset without the main camera unchanged", () => {
		const single = asset({ id: "a2", additionalCameraTracks: [] });
		const out = withMainCamera(doc({ mainCamera: 2 }, [asset(), single]));
		expect(out.assets[1]).toEqual(single);
	});

	it("swaps camera settings: perspective travels, the layout fields drive the main camera", () => {
		const out = withMainCamera(
			doc({
				mainCamera: 2,
				cameraSettings: [
					{ perspective: perspective(1) },
					{ mirror: true },
					{ rotation: 90, mirror: true, perspective: perspective(2) },
				],
			}),
		);
		expect(legacyOf(out).cameraSettings).toEqual([
			{ perspective: perspective(2) },
			{ mirror: true },
			{ perspective: perspective(1) },
		]);
	});

	it("does not add empty settings entries", () => {
		const out = withMainCamera(doc({ mainCamera: 2, cameraSettings: [null, { mirror: true }] }));
		expect(legacyOf(out).cameraSettings).toEqual([null, { mirror: true }]);
		const bare = withMainCamera(
			doc({ mainCamera: 2, cameraSettings: [null, null, { rotation: 90 }] }),
		);
		expect(legacyOf(bare).cameraSettings).toBeUndefined();
	});

	it("swaps camera 1 and the main camera in layout slots", () => {
		const out = withMainCamera(
			doc({
				mainCamera: 2,
				cameraLayoutRegions: [
					{
						id: "l1",
						startMs: 0,
						endMs: 1000,
						template: "side-by-side",
						slots: [{ camera: 0 }, { camera: 2 }],
					},
					{
						id: "l2",
						startMs: 1000,
						endMs: 2000,
						template: "screen-pip",
						slots: [{ camera: 1 }],
					},
				],
			}),
		);
		const regions = legacyOf(out).cameraLayoutRegions as { slots: { camera: number }[] }[];
		expect(regions[0].slots.map((s) => s.camera)).toEqual([2, 0]);
		expect(regions[1].slots.map((s) => s.camera)).toEqual([1]);
	});

	it("swaps the desk camera", () => {
		expect(legacyOf(withMainCamera(doc({ mainCamera: 2, deskCamera: 2 }))).deskCamera).toBe(0);
		expect(legacyOf(withMainCamera(doc({ mainCamera: 2, deskCamera: 0 }))).deskCamera).toBe(2);
		expect(legacyOf(withMainCamera(doc({ mainCamera: 2, deskCamera: 1 }))).deskCamera).toBe(1);
	});

	it("settles an automatic desk camera on the unswapped cameras, never on the main one", () => {
		// Only device 2 has a perspective, but device 2 is the main camera: the automatic desk
		// camera passes over it and takes device 0, which sits at index 2 after the swap.
		const out = withMainCamera(
			doc({
				mainCamera: 2,
				cameraSettings: [null, null, { perspective: perspective(2) }],
				deskRegions: [{ id: "d1", startMs: 0, endMs: 1000 }],
			}),
		);
		expect(legacyOf(out).deskCamera).toBe(2);
		expect(legacyOf(out).deskRegions).toHaveLength(1);
		// A non-main camera with a perspective wins over camera 1.
		const withDesk = withMainCamera(
			doc({ mainCamera: 2, cameraSettings: [null, { perspective: perspective(2) }] }),
		);
		expect(legacyOf(withDesk).deskCamera).toBe(1);
	});

	it("settles an automatic desk camera without a perspective on camera 1", () => {
		// The first non-main camera in index order is device 0, at the main camera's index after
		// the swap.
		expect(legacyOf(withMainCamera(doc({ mainCamera: 2 }))).deskCamera).toBe(2);
		const two = asset({ additionalCameraTracks: [track("/c2.mp4")] });
		expect(legacyOf(withMainCamera(doc({ mainCamera: 1 }, [two]))).deskCamera).toBe(1);
	});

	it("drops the desk sections when no desk camera resolves", () => {
		// With a main camera m >= 1 available, the fallback always finds a desk camera; null
		// only comes from a document without a main camera, which is returned unchanged.
		const single = asset({ additionalCameraTracks: [] });
		const d = doc({ mainCamera: 2, deskRegions: [{ id: "d1", startMs: 0, endMs: 1000 }] }, [
			single,
		]);
		expect(withMainCamera(d)).toBe(d);
	});

	it("does not mutate the input", () => {
		const d = doc({ mainCamera: 2, deskCamera: 2, cameraSettings: [null, null, { rotation: 90 }] });
		const before = structuredClone(d);
		withMainCamera(d);
		expect(d).toEqual(before);
	});
});
