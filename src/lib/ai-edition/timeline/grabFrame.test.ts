// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { grabFrame, grabFrameDataUrl } from "./grabFrame";

type FakeVideo = {
	preload: string;
	muted: boolean;
	playsInline: boolean;
	duration: number;
	videoWidth: number;
	videoHeight: number;
	onloadedmetadata: (() => void) | null;
	onseeked: (() => void) | null;
	onerror: (() => void) | null;
	seekedTo: number | null;
	src: string;
	currentTime: number;
	removeAttribute: () => void;
	load: () => void;
};

/** jsdom has no media: fake a video that "loads" on `src` and "seeks" on `currentTime`. */
function installFakes(opts: { fail?: boolean } = {}) {
	const draws: unknown[][] = [];
	const imageData = { width: 48, height: 27, data: new Uint8ClampedArray(48 * 27 * 4) };
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({
			drawImage: (...args: unknown[]) => draws.push(args),
			getImageData: () => imageData,
		}),
		toDataURL: () => "data:image/png;base64,AAAA",
	};
	let currentTime: number | null = null;
	const video: FakeVideo = {
		preload: "",
		muted: false,
		playsInline: false,
		duration: 10,
		videoWidth: 192,
		videoHeight: 108,
		onloadedmetadata: null,
		onseeked: null,
		onerror: null,
		seekedTo: null,
		removeAttribute: vi.fn(),
		load: vi.fn(),
		set src(_value: string) {
			queueMicrotask(() => (opts.fail ? video.onerror?.() : video.onloadedmetadata?.()));
		},
		get src() {
			return "";
		},
		set currentTime(value: number) {
			currentTime = value;
			video.seekedTo = value;
			queueMicrotask(() => video.onseeked?.());
		},
		get currentTime() {
			return currentTime ?? 0;
		},
	};
	const real = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag === "video") return video;
		if (tag === "canvas") return canvas;
		return real(tag);
	}) as typeof document.createElement);
	return { video, canvas, draws, imageData };
}

afterEach(() => vi.restoreAllMocks());

describe("grabFrame", () => {
	it("seeks to the time and draws the frame", async () => {
		const { video, canvas, draws, imageData } = installFakes();
		const data = await grabFrame("file:///cam.mp4", 3.5, 96);
		expect(video.seekedTo).toBe(3.5);
		expect(draws).toHaveLength(1);
		// 192x108 scaled so the longer side is 96.
		expect(canvas.width).toBe(96);
		expect(canvas.height).toBe(54);
		expect(data).toBe(imageData);
	});

	it("gives a data URL for the thumbnail", async () => {
		installFakes();
		await expect(grabFrameDataUrl("file:///cam.mp4", 1)).resolves.toBe(
			"data:image/png;base64,AAAA",
		);
	});

	it("rejects on error with a clear message", async () => {
		installFakes({ fail: true });
		await expect(grabFrame("file:///missing.mp4", 1)).rejects.toThrow(
			"Could not load the video to grab a frame from file:///missing.mp4",
		);
	});
});
