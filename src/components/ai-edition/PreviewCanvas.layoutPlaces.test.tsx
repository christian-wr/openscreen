// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AxcutAsset, AxcutClip } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { AnchoredCameraLayoutRegion } from "@/lib/cameraLayouts";
import { clearWebcamNativeSizeCache, setWebcamNativeSize } from "@/native/webcamSizeCache";
import { PreviewCanvas } from "./PreviewCanvas";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));
// The pixel and media layers are not under test: only the DOM hitboxes are.
vi.mock("./NativeCompositorOverlay", () => ({ NativeCompositorOverlay: () => null }));
vi.mock("./VirtualPreview", () => ({ VirtualPreview: () => null }));
vi.mock("./WebcamOverlay", () => ({ WebcamOverlay: () => null }));
vi.mock("./ZoomFocusOverlay", () => ({ ZoomFocusOverlay: () => null }));
vi.mock("./AnnotationLayer", () => ({ AnnotationLayer: () => null }));

const track = (path: string) => ({
	sourcePath: path,
	startMs: 0,
	offsetMs: 0,
	visible: true,
	width: 1920,
	height: 1080,
});

const asset = {
	id: "a1",
	kind: "video",
	label: "a",
	originalPath: "/screen.mp4",
	cameraTrack: track("/c1.mp4"),
	additionalCameraTracks: [{ ...track("/c2.mp4"), label: "" }],
} as unknown as AxcutAsset;

const clip = {
	id: "c1",
	assetId: "a1",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "user",
	reason: "",
} as AxcutClip;

const region = (
	template: AnchoredCameraLayoutRegion["template"],
	cameras: number[],
): AnchoredCameraLayoutRegion => ({
	id: "l1",
	startMs: 0,
	endMs: 10_000,
	template,
	slots: cameras.map((camera) => ({ camera })),
	clipId: "c1",
	assetId: "a1",
	sourceStartSec: 0,
	sourceEndSec: 10,
});

type Props = ComponentProps<typeof PreviewCanvas>;

function renderCanvas(
	over: Partial<Props>,
	assets: AxcutAsset[] = [asset],
	legacyEditor: Record<string, unknown> | null = null,
) {
	const document = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({
		projectId: "p",
		document: { ...document, assets, legacyEditor },
	});
	const props: Props = {
		videoSources: [],
		clips: [clip],
		seekTarget: null,
		onTimeChange: vi.fn(),
		onSeek: vi.fn(),
		onLoadedMetadata: vi.fn(),
		onVideoElement: vi.fn(),
		currentTimeSec: 5,
		onLayoutSlotRectLive: vi.fn(),
		onLayoutSlotRectCommit: vi.fn(),
		...over,
	};
	render(
		<div>
			<PreviewCanvas {...props} />
		</div>,
	);
	return props;
}

beforeAll(() => {
	// jsdom lays nothing out: give every element a 1000×500 box and a pointer-capture API.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 1000,
		height: 500,
		right: 1000,
		bottom: 500,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("PreviewCanvas layout places", () => {
	it("a selected layout section shows a handle per pip place", () => {
		const regions = [region("screen-pip", [0, 1])];
		renderCanvas({ cameraLayoutRegions: regions, selectedLayoutRegionId: "l1" });
		expect(screen.getAllByTestId("layout-place")).toHaveLength(2);
		expect(screen.getAllByTestId("layout-place-handle")).toHaveLength(2);
	});

	it("gives a frame-filling place no handle", () => {
		const regions = [region("camera-full-pip", [1, 0])];
		renderCanvas({ cameraLayoutRegions: regions, selectedLayoutRegionId: "l1" });
		expect(screen.getAllByTestId("layout-place-handle")).toHaveLength(1);
	});

	it("shows nothing when the section is not selected or the playhead is outside it", () => {
		const regions = [region("screen-pip", [0, 1])];
		renderCanvas({ cameraLayoutRegions: regions, selectedLayoutRegionId: null });
		expect(screen.queryByTestId("layout-place")).toBeNull();
		cleanup();
		renderCanvas({
			cameraLayoutRegions: [{ ...regions[0], endMs: 2000 }],
			selectedLayoutRegionId: "l1",
		});
		expect(screen.queryByTestId("layout-place")).toBeNull();
	});

	it("moves a place live and commits once on release", () => {
		const regions = [region("camera-full-pip", [1, 0])];
		const onLive = vi.fn<NonNullable<Props["onLayoutSlotRectLive"]>>();
		const props = renderCanvas({
			cameraLayoutRegions: regions,
			selectedLayoutRegionId: "l1",
			onLayoutSlotRectLive: onLive,
		});
		const place = screen.getByTestId("layout-place");
		fireEvent.pointerDown(place, { pointerId: 1, clientX: 500, clientY: 250 });
		fireEvent.pointerMove(place, { pointerId: 1, clientX: 400, clientY: 200 });
		fireEvent.pointerMove(place, { pointerId: 1, clientX: 300, clientY: 150 });
		fireEvent.pointerUp(place, { pointerId: 1 });
		expect(onLive).toHaveBeenCalledTimes(2);
		const [[id, slotIndex, first], [, , last]] = onLive.mock.calls;
		// Slot 1 is the PiP of camera-full-pip (slot 0 fills the frame).
		expect([id, slotIndex]).toEqual(["l1", 1]);
		// Both moves are measured from the grab: the second one went twice as far.
		expect(first.x - last.x).toBeCloseTo(0.1);
		expect(first.y - last.y).toBeCloseTo(0.1);
		expect(last.width).toBe(first.width);
		expect(props.onLayoutSlotRectCommit).toHaveBeenCalledTimes(1);
	});

	it("leaves no undo step for a click without a move", () => {
		const regions = [region("screen-pip", [0])];
		const props = renderCanvas({ cameraLayoutRegions: regions, selectedLayoutRegionId: "l1" });
		const place = screen.getByTestId("layout-place");
		fireEvent.pointerDown(place, { pointerId: 1, clientX: 500, clientY: 250 });
		fireEvent.pointerUp(place, { pointerId: 1 });
		expect(props.onLayoutSlotRectCommit).not.toHaveBeenCalled();
	});
});

// With camera 2 as the main camera the scene lays it out in camera 1's place, sized from its
// probed file; the hitbox must sit on that same window.
describe("PreviewCanvas layout places with a main camera", () => {
	afterEach(() => clearWebcamNativeSizeCache());

	// Camera 2 has no stored size: only its probe says it is portrait, and only camera 1's
	// role reads the probe.
	const portraitUnsized = {
		...asset,
		additionalCameraTracks: [
			{ sourcePath: "/c2.mp4", startMs: 0, offsetMs: 0, visible: true, label: "" },
		],
	} as unknown as AxcutAsset;
	const placeAspect = () => {
		const style = screen.getByTestId("layout-place").style;
		// Rect fractions of a 16:9 frame, back to pixels.
		return (Number.parseFloat(style.width) / Number.parseFloat(style.height)) * (16 / 9);
	};

	it("sizes the main camera's place from its probed size", () => {
		setWebcamNativeSize("/c2.mp4", { width: 1080, height: 1920 });
		const regions = [region("screen-pip", [1])];
		const rectangle = { webcamMaskShape: "rectangle" };
		renderCanvas(
			{ cameraLayoutRegions: regions, selectedLayoutRegionId: "l1" },
			[portraitUnsized],
			rectangle,
		);
		const asCameraTwo = placeAspect();
		cleanup();
		renderCanvas(
			{ cameraLayoutRegions: regions, selectedLayoutRegionId: "l1" },
			[portraitUnsized],
			{ ...rectangle, mainCamera: 1 },
		);
		expect(placeAspect()).toBeLessThan(asCameraTwo / 2);
	});
});
