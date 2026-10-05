import { describe, expect, it } from "vitest";
import { defaultLayoutCameras, layoutTemplateBlock } from "./layoutMenu";

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
