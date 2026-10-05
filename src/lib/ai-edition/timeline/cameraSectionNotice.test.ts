import { describe, expect, it } from "vitest";
import { cameraSectionNotice } from "./cameraSectionNotice";

const t = (key: string) => key;

describe("cameraSectionNotice", () => {
	it("says nothing when the section was added", () => {
		expect(cameraSectionNotice("added", t)).toBeNull();
	});

	it("reuses the cannot-place notice for an occupied spot", () => {
		expect(cameraSectionNotice("occupied", t)).toEqual({
			title: "errors.cannotPlaceCameraFullscreen",
			description: "errors.cameraFullscreenExistsAtLocation",
		});
	});

	it("has a short notice for a missing or too small camera set", () => {
		expect(cameraSectionNotice("no-camera", t)?.title).toBe("errors.noCamera");
		expect(cameraSectionNotice("too-few-cameras", t)?.title).toBe("errors.tooFewCameras");
	});
});
