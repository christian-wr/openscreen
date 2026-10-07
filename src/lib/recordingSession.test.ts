import { describe, expect, it } from "vitest";
import {
	findRecordingCameraResult,
	normalizeProjectMedia,
	normalizeRecordingSession,
} from "./recordingSession";

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

describe("deskCamera", () => {
	const base = {
		screenVideoPath: "/s.mp4",
		webcamVideoPath: "/w.mp4",
		additionalWebcams: [
			{ path: "/w-2.mp4", label: "Desk" },
			{ path: "/w-3.mp4", label: "Side" },
		],
		createdAt: 1,
	};

	it("keeps a desk camera that names a recorded camera", () => {
		expect(normalizeRecordingSession({ ...base, deskCamera: 0 })?.deskCamera).toBe(0);
		expect(normalizeRecordingSession({ ...base, deskCamera: 2 })?.deskCamera).toBe(2);
	});

	it("drops a desk camera that names no recorded camera or is not an index", () => {
		for (const deskCamera of [3, -1, 1.5, "1", null, Number.NaN]) {
			expect(normalizeRecordingSession({ ...base, deskCamera })).not.toHaveProperty("deskCamera");
		}
		expect(
			normalizeRecordingSession({ screenVideoPath: "/s.mp4", deskCamera: 0, createdAt: 1 }),
		).not.toHaveProperty("deskCamera");
	});

	it("leaves a session without a desk camera unchanged", () => {
		expect(normalizeRecordingSession(base)).toEqual(base);
	});

	it("is not part of the project media", () => {
		expect(normalizeProjectMedia({ ...base, deskCamera: 1 })).not.toHaveProperty("deskCamera");
	});
});

describe("findRecordingCameraResult", () => {
	it("passes the desk camera on with camera 1", () => {
		expect(
			findRecordingCameraResult({
				webcamVideoPath: "/w.mp4",
				webcamOffsetMs: 5,
				additionalWebcams: [{ path: "/w-2.mp4", label: "Desk" }],
				deskCamera: 1,
			}),
		).toEqual({
			success: true,
			webcamVideoPath: "/w.mp4",
			offsetMs: 5,
			additionalWebcams: [{ path: "/w-2.mp4", label: "Desk" }],
			deskCamera: 1,
		});
	});

	it("answers without a desk camera when none was recorded", () => {
		expect(findRecordingCameraResult({ webcamVideoPath: "/w.mp4" })).toEqual({
			success: true,
			webcamVideoPath: "/w.mp4",
			offsetMs: 0,
		});
	});

	it("fails without camera 1", () => {
		expect(findRecordingCameraResult({ deskCamera: 0 })).toEqual({
			success: false,
			error: "No camera attached to this recording",
		});
	});
});
