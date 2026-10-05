import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "../schema";
import { camerasForClipAt, camerasOfSection, projectCameras } from "./cameraList";

const t = (key: string, vars?: Record<string, unknown>) => `${key}:${String(vars?.n ?? "")}`;

const asset = (over: Partial<AxcutAsset> = {}): AxcutAsset =>
	({
		id: "a1",
		kind: "video",
		label: "a",
		originalPath: "/screen.mp4",
		cameraTrack: { sourcePath: "/c1.mp4", startMs: 0, offsetMs: 0, visible: true, width: 1920 },
		additionalCameraTracks: [
			{ sourcePath: "/c2.mp4", startMs: 0, offsetMs: 0, visible: true, label: "Desk" },
			{ sourcePath: "/c3.mp4", startMs: 0, offsetMs: 0, visible: true, label: "" },
		],
		...over,
	}) as AxcutAsset;

const clip = (id: string, assetId: string, start: number, end: number): AxcutClip =>
	({
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: end - start,
		timelineStartSec: start,
		timelineEndSec: end,
		wordRefs: [],
		origin: "system",
		reason: "",
	}) as AxcutClip;

describe("projectCameras", () => {
	it("labels camera 1 and falls back for empty labels", () => {
		const cams = projectCameras(asset(), t);
		expect(cams.map((c) => c.label)).toEqual(["cameras.cameraN:1", "Desk", "cameras.cameraN:3"]);
		expect(cams.map((c) => c.index)).toEqual([0, 1, 2]);
		expect(cams[0].width).toBe(1920);
	});

	it("a hidden track is unavailable", () => {
		const hidden = asset({
			additionalCameraTracks: [
				{ sourcePath: "/c2.mp4", startMs: 0, offsetMs: 0, visible: false, label: "" },
			],
		});
		const cams = projectCameras(hidden, t);
		expect(cams.map((c) => c.available)).toEqual([true, false]);
		expect(projectCameras(undefined, t)).toEqual([]);
	});
});

describe("camerasForClipAt", () => {
	it("cameras of the clip under the playhead", () => {
		const single = asset({ id: "a2", additionalCameraTracks: [] });
		const doc = {
			assets: [asset(), single],
			timeline: { clips: [clip("c1", "a1", 0, 5), clip("c2", "a2", 5, 10)] },
		} as unknown as AxcutDocument;
		expect(camerasForClipAt(doc, 2, t)).toHaveLength(3);
		expect(camerasForClipAt(doc, 7, t)).toHaveLength(1);
	});
});

describe("camerasOfSection", () => {
	const single = asset({ id: "a2", additionalCameraTracks: [] });
	const doc = {
		assets: [asset(), single],
		timeline: { clips: [clip("c1", "a1", 0, 5), clip("c2", "a2", 5, 10)] },
	} as unknown as AxcutDocument;

	it("reads the cameras of the anchored row's asset, not of the clip at its middle", () => {
		// The span's middle (7 s) lies on the single-camera clip; the anchor names a1.
		const row = { assetId: "a1", startMs: 4000, endMs: 10000 };
		expect(camerasOfSection(doc, row, t)).toHaveLength(3);
	});

	it("falls back to the clip under the middle for a row without an anchor", () => {
		expect(camerasOfSection(doc, { startMs: 4000, endMs: 10000 }, t)).toHaveLength(1);
	});
});
