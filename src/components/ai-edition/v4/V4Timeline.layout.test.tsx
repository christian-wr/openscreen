// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const VIEWPORT_PX = 900;
const TOTAL_SEC = 100; // 9 px per second

// A bare key, with the variables appended, so a label built from keys stays readable.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, string | number>) =>
		vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

import { ShortcutsProvider } from "@/contexts/ShortcutsContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { V4Timeline } from "./V4Timeline";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {
			/* noop */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => VIEWPORT_PX,
	});
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: VIEWPORT_PX,
			bottom: 100,
			width: VIEWPORT_PX,
			height: 100,
			toJSON() {
				/* unused */
			},
		}),
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() =>
			({
				measureText: (text: string) => ({ width: text.length * 6 }),
			}) as unknown as CanvasRenderingContext2D,
	);
});

beforeEach(() => {
	useProjectStore.setState({ currentTimeSec: 30 });
});

afterEach(() => {
	cleanup();
	toastError.mockClear();
});

const CLIP = {
	id: "c1",
	assetId: "a1",
	timelineStartSec: 0,
	timelineEndSec: TOTAL_SEC,
	sourceStartSec: 0,
	sourceEndSec: TOTAL_SEC,
};
const track = (path: string, extra: Record<string, unknown> = {}) => ({
	sourcePath: path,
	startMs: 0,
	offsetMs: 0,
	visible: true,
	...extra,
});
const ONE_CAMERA = {
	id: "a1",
	label: "rec",
	durationSec: TOTAL_SEC,
	cameraTrack: track("/tmp/cam1.webm"),
};
const TWO_CAMERAS = {
	...ONE_CAMERA,
	additionalCameraTracks: [track("/tmp/cam2.webm", { label: "Desk" })],
};
const LAYOUT = {
	id: "cl1",
	startMs: 20_000,
	endMs: 60_000,
	template: "camera-full-pip",
	slots: [{ camera: 1 }, { camera: 0 }],
	assetId: "a1",
};

function renderTimeline(
	assets: Array<Record<string, unknown>>,
	layouts: unknown[] = [],
	fullCameras: unknown[] = [],
) {
	const tl = {
		clips: [CLIP],
		transcripts: [],
		assets,
		annotationRegions: [],
		speedRegions: [],
		cameraFullscreenRegions: fullCameras,
		cameraLayoutRegions: layouts,
		zoomRegions: [],
		trimRanges: [],
		hasEditRegions: false,
		selection: null,
		multiSelection: [],
		clipSelection: null,
		audioTracks: [],
		selectedAudioTrackId: null,
		selectAudioTrack: vi.fn(),
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		addCameraFullscreen: vi.fn(async () => "added"),
		addCameraLayout: vi.fn(async () => "added"),
		updateCameraLayoutSpan: vi.fn(async () => undefined),
	};
	render(
		<ShortcutsProvider>
			<V4Timeline
				tl={tl as unknown as ReturnType<typeof useTimeline>}
				setCurrentTime={vi.fn()}
				playing={false}
				onTogglePlay={vi.fn()}
				onEditClip={vi.fn()}
				onAddVoiceover={vi.fn()}
			/>
		</ShortcutsProvider>,
	);
	return tl;
}

describe("V4Timeline layout lane", () => {
	it("renders layout pills in the full camera lane", () => {
		renderTimeline([TWO_CAMERAS], [LAYOUT], [{ id: "cf1", startMs: 70_000, endMs: 90_000 }]);
		// The Full Camera pill keeps its (now translated) label next to the layout pill.
		expect(screen.getByText("labels.cameraFullscreen")).toBeInTheDocument();
		expect(screen.getByText(/labels\.layoutCameraFullPip/)).toBeInTheDocument();
	});

	it("names the pill after its template and the cameras of its places", () => {
		renderTimeline([TWO_CAMERAS], [LAYOUT]);
		const pill = screen.getByText("labels.layoutCameraFullPip · Desk, cameras.cameraN:1");
		expect(pill).toBeInTheDocument();
	});

	it("selects a layout pill as a cameraLayout region", () => {
		const tl = renderTimeline([TWO_CAMERAS], [LAYOUT]);
		const pill = screen.getByText(/labels\.layoutCameraFullPip/).closest("[role='button']");
		fireEvent.pointerDown(pill as Element, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 0 }));
		expect(tl.selectRegion).toHaveBeenCalledWith("cameraLayout", "cl1", { additive: false });
	});

	it("a layout pill drag calls updateCameraLayoutSpan", () => {
		const tl = renderTimeline([TWO_CAMERAS], [LAYOUT]);
		const pill = screen.getByText(/labels\.layoutCameraFullPip/).closest("[role='button']");
		fireEvent.pointerDown(pill as Element, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 90 }));
		expect(tl.updateCameraLayoutSpan).toHaveBeenCalledTimes(1);
		const [id, startMs, endMs] = tl.updateCameraLayoutSpan.mock.calls[0] as unknown as [
			string,
			number,
			number,
		];
		expect(id).toBe("cl1");
		expect(startMs).toBeCloseTo(30_000, -2);
		expect(endMs - startMs).toBeCloseTo(40_000, -2);
	});

	it("the add-layout menu disables multi-camera templates for a one-camera project", async () => {
		renderTimeline([ONE_CAMERA]);
		fireEvent.click(screen.getByLabelText("buttons.addLayout"));
		const sideBySide = await screen.findByRole("button", { name: /labels\.layoutSideBySide/ });
		expect(sideBySide).toBeDisabled();
		expect(screen.getByRole("button", { name: /labels\.layoutCameraFullPip/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /labels\.layoutScreenPip/ })).toBeEnabled();
		expect(screen.getByRole("button", { name: /labels\.layoutCameraFull$/ })).toBeEnabled();
	});

	it("adds a camera-full-pip layout desk camera first and reports an occupied spot", async () => {
		const tl = renderTimeline([TWO_CAMERAS]);
		tl.addCameraLayout.mockResolvedValueOnce("occupied");
		fireEvent.click(screen.getByLabelText("buttons.addLayout"));
		fireEvent.click(await screen.findByRole("button", { name: /labels\.layoutCameraFullPip/ }));
		expect(tl.addCameraLayout).toHaveBeenCalledWith("camera-full-pip", [1, 0], expect.any(Number));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"errors.cannotPlaceCameraFullscreen",
				expect.objectContaining({ description: "errors.cameraFullscreenExistsAtLocation" }),
			),
		);
	});

	it("shows a notice when the Add Full Camera button is refused", async () => {
		const tl = renderTimeline([ONE_CAMERA]);
		tl.addCameraFullscreen.mockResolvedValueOnce("occupied" as never);
		fireEvent.click(screen.getByLabelText("buttons.addCameraFullscreen"));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
	});
});
