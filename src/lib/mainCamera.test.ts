import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutDocument } from "./ai-edition/schema";
import { resolveMainCamera, withMainCamera } from "./mainCamera";

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

	it("does not mutate the input", () => {
		const d = doc({ mainCamera: 2, deskCamera: 2, cameraSettings: [null, null, { rotation: 90 }] });
		const before = structuredClone(d);
		withMainCamera(d);
		expect(d).toEqual(before);
	});
});
