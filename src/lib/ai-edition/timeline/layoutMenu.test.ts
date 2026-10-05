import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip } from "../schema";
import { camerasForLayoutMenu, defaultLayoutCameras, layoutTemplateBlock } from "./layoutMenu";

describe("layoutTemplateBlock", () => {
	it("blocks templates that need more cameras than the clip has", () => {
		const ctx = { cameraCount: 1, blockPreset: false };
		expect(layoutTemplateBlock("side-by-side", ctx)).toBe("needs-cameras");
		expect(layoutTemplateBlock("camera-full-pip", ctx)).toBe("needs-cameras");
		expect(layoutTemplateBlock("screen-pip", ctx)).toBeNull();
		expect(layoutTemplateBlock("camera-full", ctx)).toBeNull();
	});

	it("blocks PiP templates under a block layout preset", () => {
		const ctx = { cameraCount: 3, blockPreset: true };
		expect(layoutTemplateBlock("screen-pip", ctx)).toBe("block-layout");
		expect(layoutTemplateBlock("camera-full-pip", ctx)).toBe("block-layout");
		expect(layoutTemplateBlock("side-by-side", ctx)).toBeNull();
	});
});

describe("defaultLayoutCameras", () => {
	it("takes the first N available cameras", () => {
		expect(defaultLayoutCameras("screen-pip", [0, 1, 2])).toEqual([0]);
		expect(defaultLayoutCameras("side-by-side", [0, 2, 3])).toEqual([0, 2]);
		expect(defaultLayoutCameras("camera-full", [2, 3])).toEqual([2]);
	});

	it("puts the desk camera first for camera-full-pip", () => {
		expect(defaultLayoutCameras("camera-full-pip", [0, 1])).toEqual([1, 0]);
		expect(defaultLayoutCameras("camera-full-pip", [0, 2])).toEqual([0, 2]);
	});
});

describe("camerasForLayoutMenu", () => {
	const t = (key: string) => key;
	const track = { sourcePath: "/c.mp4", startMs: 0, offsetMs: 0, visible: true, label: "" };
	const assets = [
		{ id: "screenOnly", kind: "video", additionalCameraTracks: [] },
		{ id: "twoCams", kind: "video", cameraTrack: track, additionalCameraTracks: [track] },
	] as unknown as AxcutAsset[];
	const clip = (id: string, assetId: string, start: number, end: number): AxcutClip =>
		({
			id,
			assetId,
			sourceStartSec: 0,
			sourceEndSec: end - start,
			timelineStartSec: start,
			timelineEndSec: end,
		}) as AxcutClip;

	it("uses the clip under the playhead", () => {
		const clips = [clip("a", "screenOnly", 0, 5), clip("b", "twoCams", 5, 10)];
		expect(camerasForLayoutMenu(clips, assets, 7, t)).toHaveLength(2);
	});

	it("falls back to the nearest clip with cameras when the playhead clip has none", () => {
		const clips = [clip("a", "twoCams", 0, 5), clip("b", "screenOnly", 5, 10)];
		expect(camerasForLayoutMenu(clips, assets, 8, t)).toHaveLength(2);
	});

	it("is empty only when no clip has a camera", () => {
		expect(camerasForLayoutMenu([clip("a", "screenOnly", 0, 5)], assets, 2, t)).toEqual([]);
		expect(camerasForLayoutMenu([], assets, 0, t)).toEqual([]);
	});
});
