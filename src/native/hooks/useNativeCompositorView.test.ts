// @vitest-environment jsdom
/**
 * The fatal-error channel (PR #162).
 *
 * `createView` returns an id long before the native render thread can fail, so a host
 * that cannot create a D3D11 device used to leave the user with a black canvas and an
 * `eprintln!` nobody reads. The addon now reports the dead thread through `readFrame`,
 * and this hook turns that into `error`.
 *
 * The half worth guarding is the negative one: `readFrame` also rejects when there is no
 * Electron bridge at all (pure web `npm run dev`, jsdom), and the addon being absent is a
 * normal no-op, not a failure. Neither may raise the banner.
 */

import { renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createCompositorView: vi.fn(),
	readCompositorFrame: vi.fn(),
	destroyCompositorView: vi.fn(),
}));

vi.mock("../compositorViewClient", () => ({
	createCompositorView: mocks.createCompositorView,
	readCompositorFrame: mocks.readCompositorFrame,
	destroyCompositorView: mocks.destroyCompositorView,
	setCompositorParam: vi.fn(),
	setCompositorPlaying: vi.fn(),
	setCompositorRect: vi.fn(),
}));

import { useNativeCompositorView } from "./useNativeCompositorView";

// jsdom ships no ResizeObserver; the hook constructs one to track the canvas box.
// Nothing here observes anything — these tests only exercise the pull loop.
globalThis.ResizeObserver = class {
	observe() {
		// inert on purpose: the canvas box never changes in these tests
	}
	unobserve() {
		// see observe()
	}
	disconnect() {
		// see observe()
	}
} as unknown as typeof ResizeObserver;

/** A canvas with a stubbed 2D context — jsdom has none, and the pull loop bails without it. */
function stubCanvasRef(): RefObject<HTMLCanvasElement> {
	const canvas = document.createElement("canvas");
	canvas.getContext = vi.fn(() => ({})) as unknown as HTMLCanvasElement["getContext"];
	return { current: canvas };
}

/** This jsdom build exposes no `ImageData` either — the paint path constructs one per
 *  frame. A structural stand-in is enough: nothing here inspects the pixels. */
if (typeof globalThis.ImageData === "undefined") {
	globalThis.ImageData = class {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		constructor(data: Uint8ClampedArray, width: number, height: number) {
			this.data = data;
			this.width = width;
			this.height = height;
		}
	} as unknown as typeof ImageData;
}

/** jsdom has no `createImageBitmap`; the paint path calls it for every delivered frame.
 *  Without it the call throws synchronously, the hook mistakes that for a dead render
 *  thread, and no test can ever observe a successful paint. */
globalThis.createImageBitmap = (async () => ({
	close: () => {
		// nothing to release in the stub
	},
})) as unknown as typeof createImageBitmap;

/** A canvas whose 2D context records draws, for the tests that deliver real pixels. */
function paintableCanvasRef(): { ref: RefObject<HTMLCanvasElement>; draws: () => number } {
	const canvas = document.createElement("canvas");
	let draws = 0;
	const ctx = {
		drawImage: () => {
			draws += 1;
		},
		putImageData: () => {
			draws += 1;
		},
	};
	canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
	return { ref: { current: canvas }, draws: () => draws };
}

const DEVICE_FAILURE =
	"this display adapter has no D3D11 video decoder (0x887A0004). OpenScreen decodes every preview and export frame with D3D11VA";

describe("useNativeCompositorView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("surfaces the native message when the render thread dies", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
	});

	it("stops polling once the error is terminal — the thread never restarts", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
		const callsAtFailure = mocks.readCompositorFrame.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(callsAtFailure);
	});

	it("stays quiet when the addon is absent (synthetic id, no frames, no error)", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: -1 });
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.readCompositorFrame).toHaveBeenCalled());
		expect(result.current.error).toBeNull();
	});

	/**
	 * A rect change resizes the canvas drawing buffer, and assigning `canvas.width`
	 * CLEARS it. The native side only records the new size — `set_rect` in
	 * `crates/compositor/src/live.rs` writes `shared.preview_size` and returns; it
	 * composes nothing and publishes no new generation.
	 *
	 * So unless the hook forgets what it last painted, the pull loop keeps asking for
	 * "anything newer than gen N", keeps getting null, and the cleared canvas stays
	 * black — until something else happens to compose a frame. While the preview is
	 * paused that is never: measured on a live editor, the pull loop went 123 s
	 * between paints while idle. That is the black preview users report.
	 */
	it("re-requests the current frame after a rect change, so the cleared canvas is repainted", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.destroyCompositorView.mockResolvedValue(undefined);
		const sinceGens: number[] = [];
		mocks.readCompositorFrame.mockImplementation(async (_id: number, sinceGen: number) => {
			sinceGens.push(sinceGen);
			// The compositor holds exactly one composed frame, generation 1. It is
			// handed over only when the caller admits to having painted nothing newer.
			return sinceGen === 0
				? { gen: 1, width: 2, height: 2, data: new Uint8Array(2 * 2 * 4) }
				: null;
		});

		const { ref, draws } = paintableCanvasRef();
		let boxWidth = 640;
		ref.current.getBoundingClientRect = (() => ({
			left: 0,
			top: 0,
			width: boxWidth,
			height: 360,
		})) as unknown as HTMLElement["getBoundingClientRect"];

		renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));

		// First paint: the hook has nothing yet, asks with 0, and gets generation 1.
		await waitFor(() => expect(sinceGens).toContain(0));
		await waitFor(() => expect(sinceGens.some((gen) => gen === 1)).toBe(true));
		const askedBeforeResize = sinceGens.length;
		const drawsBeforeResize = draws();

		// Now the preview box changes width by one device pixel — the ordinary layout
		// jitter that `applyRectNow` exists to follow. This clears the canvas.
		boxWidth = 641;
		window.dispatchEvent(new Event("resize"));

		// The hook must go back to asking with 0. Asking with 1 forever means the
		// canvas it just cleared is never repainted.
		await waitFor(() => {
			expect(sinceGens.slice(askedBeforeResize)).toContain(0);
		});
		// And the point of asking: pixels actually land on the cleared canvas again.
		await waitFor(() => expect(draws()).toBeGreaterThan(drawsBeforeResize));
	});

	it("stays quiet without an Electron bridge — no view id, so nothing is ever polled", async () => {
		mocks.createCompositorView.mockRejectedValue(new Error("Native bridge unavailable."));
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).not.toHaveBeenCalled();
		expect(result.current.error).toBeNull();
	});
});
