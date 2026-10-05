import { describe, expect, it } from "vitest";
import { normalizeProjectMedia, normalizeRecordingSession } from "./recordingSession";

describe("additionalWebcams", () => {
	it("normalizes a session without additionalWebcams unchanged", () => {
		expect(normalizeProjectMedia({ screenVideoPath: "/s.mp4", webcamVideoPath: "/w.mp4" })).toEqual(
			{
				screenVideoPath: "/s.mp4",
				webcamVideoPath: "/w.mp4",
			},
		);
	});
	it("keeps valid entries in order", () => {
		const media = normalizeProjectMedia({
			screenVideoPath: "/s.mp4",
			additionalWebcams: [
				{ path: " /w-2.mp4 ", label: "Desk" },
				{ path: "/w-3.mp4", label: "Side" },
			],
		});
		expect(media?.additionalWebcams).toEqual([
			{ path: "/w-2.mp4", label: "Desk" },
			{ path: "/w-3.mp4", label: "Side" },
		]);
	});
	it("drops invalid additionalWebcams entries and caps the list", () => {
		const media = normalizeProjectMedia({
			screenVideoPath: "/s.mp4",
			additionalWebcams: [
				{ path: "", label: "x" },
				{ label: "no path" },
				"junk",
				{ path: "/a.mp4" },
				{ path: "/b.mp4", label: "B" },
				{ path: "/c.mp4", label: "C" },
				{ path: "/d.mp4", label: "D" },
			],
		});
		expect(media?.additionalWebcams).toEqual([
			{ path: "/a.mp4", label: "" },
			{ path: "/b.mp4", label: "B" },
			{ path: "/c.mp4", label: "C" },
		]);
		expect(
			normalizeProjectMedia({ screenVideoPath: "/s.mp4", additionalWebcams: [] }),
		).not.toHaveProperty("additionalWebcams");
	});
	it("survives a session round trip", () => {
		const session = normalizeRecordingSession({
			screenVideoPath: "/s.mp4",
			createdAt: 1,
			additionalWebcams: [{ path: "/w-2.mp4", label: "Desk" }],
		});
		expect(normalizeRecordingSession(JSON.parse(JSON.stringify(session)))).toEqual(session);
	});
});
