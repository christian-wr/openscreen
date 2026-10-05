import { describe, expect, it } from "vitest";
import { copySourceKey, pasteIdPrefix, pasteTarget } from "./regionClipboardKinds";

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
});
