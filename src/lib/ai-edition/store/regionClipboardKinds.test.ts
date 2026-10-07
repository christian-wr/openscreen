import { describe, expect, it } from "vitest";
import {
	copySourceKey,
	pasteHitsCameraSection,
	pasteIdPrefix,
	pasteTarget,
} from "./regionClipboardKinds";

describe("regionClipboardKinds", () => {
	it("copies a layout pill from the layout list, never from Full Camera", () => {
		expect(copySourceKey("cameraLayout")).toBe("cameraLayoutRegions");
		expect(copySourceKey("cameraFullscreen")).toBe("cameraFullscreenRegions");
	});

	it("pastes a layout region into the layout list", () => {
		expect(pasteTarget("cameraLayout")).toEqual({ store: "legacy", key: "cameraLayoutRegions" });
		expect(pasteTarget("cameraFullscreen")).toEqual({
			store: "legacy",
			key: "cameraFullscreenRegions",
		});
		expect(pasteTarget("speed")).toEqual({ store: "legacy", key: "speedRegions" });
	});

	it("maps every other kind to its own place or to null", () => {
		expect(copySourceKey("zoom")).toBe("zoomRegions");
		expect(copySourceKey("annotation")).toBe("annotationRegions");
		expect(copySourceKey("speed")).toBe("speedRegions");
		expect(pasteTarget("zoom")).toEqual({ store: "document", key: "zoomRanges" });
		expect(pasteTarget("annotation")).toEqual({ store: "document", key: "annotations" });
		expect(pasteTarget("trim")).toBeNull();
		expect(pasteTarget("audio")).toBeNull();
		expect(copySourceKey("trim")).toBeNull();
		expect(copySourceKey("audio")).toBeNull();
	});

	it("builds id prefixes", () => {
		expect(pasteIdPrefix("cameraLayout")).toBe("camlayout");
		expect(pasteIdPrefix("annotation")).toBe("ann");
		expect(pasteIdPrefix("speed")).toBe("speed");
	});

	describe("pasteHitsCameraSection", () => {
		const legacy = {
			cameraFullscreenRegions: [{ startMs: 0, endMs: 1000 }],
			cameraLayoutRegions: [{ startMs: 2000, endMs: 3000 }],
		};

		it("lets a Full Camera paste merge with a Full Camera region", () => {
			expect(pasteHitsCameraSection(legacy, "cameraFullscreenRegions", 500, 1500)).toBe(false);
		});

		it("refuses a Full Camera paste over a layout section", () => {
			expect(pasteHitsCameraSection(legacy, "cameraFullscreenRegions", 2500, 3500)).toBe(true);
		});

		it("refuses a layout paste over either list", () => {
			expect(pasteHitsCameraSection(legacy, "cameraLayoutRegions", 500, 1500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "cameraLayoutRegions", 2500, 3500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "cameraLayoutRegions", 3000, 4000)).toBe(false);
		});
	});

	describe("desk sections", () => {
		const legacy = {
			cameraFullscreenRegions: [{ startMs: 0, endMs: 1000 }],
			cameraLayoutRegions: [{ startMs: 2000, endMs: 3000 }],
			deskRegions: [{ startMs: 4000, endMs: 5000 }],
		};

		it("copies and pastes a desk section through its own list", () => {
			expect(copySourceKey("desk")).toBe("deskRegions");
			expect(pasteTarget("desk")).toEqual({ store: "legacy", key: "deskRegions" });
			expect(pasteIdPrefix("desk")).toBe("desk");
		});

		it("refuses a Full Camera or layout paste over a desk section", () => {
			expect(pasteHitsCameraSection(legacy, "cameraFullscreenRegions", 4500, 5500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "cameraLayoutRegions", 4500, 5500)).toBe(true);
		});

		it("refuses a desk paste over any camera section, and places it on a free spot", () => {
			expect(pasteHitsCameraSection(legacy, "deskRegions", 500, 1500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "deskRegions", 2500, 3500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "deskRegions", 4500, 5500)).toBe(true);
			expect(pasteHitsCameraSection(legacy, "deskRegions", 5000, 6000)).toBe(false);
		});
	});
});
