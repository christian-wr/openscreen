// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraSettings } from "@/components/video-editor/types";
import {
	cropToPerspective,
	fitCrop,
	perspectiveToCrop,
	planeView,
} from "@/lib/ai-edition/timeline/planeCrop";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

// A small still: 50 x 40 RGBA. jsdom has neither `ImageData` nor a video decoder.
const IMAGE = { width: 50, height: 40, data: new Uint8ClampedArray(50 * 40 * 4) } as ImageData;
vi.mock("@/lib/ai-edition/timeline/grabFrame", () => ({
	grabFrame: vi.fn(async () => IMAGE),
}));

const detectMarkedArea = vi.fn();
vi.mock("@/lib/arucoMarkers", () => ({
	detectMarkedArea: (...args: unknown[]) => detectMarkedArea(...args),
}));
const printMarkerSheet = vi.fn();
vi.mock("@/lib/markerSheet", () => ({
	printMarkerSheet: (...args: unknown[]) => printMarkerSheet(...args),
}));

import { CameraCalibrationModal } from "./CameraCalibrationModal";

const CAMERA = { index: 1, label: "Desk", src: "file:///cam.mp4", timeSec: 2 };

function renderModal(
	mode: "perspective" | "crop",
	initial: CameraSettings | null,
	onApply = vi.fn(),
	onClose = vi.fn(),
) {
	render(
		<CameraCalibrationModal
			open
			camera={CAMERA}
			mode={mode}
			initial={initial}
			onApply={onApply}
			onClose={onClose}
		/>,
	);
	return { onApply, onClose };
}

const apply = () => screen.getByRole("button", { name: "dialogs.cameraCalibration.apply" });
const stillLoaded = () =>
	waitFor(() => expect(screen.queryByText("dialogs.cameraCalibration.loading")).toBeNull());

describe("CameraCalibrationModal", () => {
	beforeEach(() => {
		// jsdom has no 2D canvas: `getContext` would log "not implemented" and return null. The
		// dialog draws nothing without a context, which is what these tests assume.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("apply is disabled for a crossed quad", async () => {
		renderModal("perspective", {
			perspective: {
				corners: [
					{ x: 0.1, y: 0.1 },
					{ x: 0.9, y: 0.9 },
					{ x: 0.9, y: 0.1 },
					{ x: 0.1, y: 0.9 },
				],
				aspect: 1,
			},
		});
		await stillLoaded();
		expect(apply()).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent("dialogs.cameraCalibration.invalidQuad");
	});

	it("apply stores corners, aspect and margin in one call", async () => {
		const { onApply, onClose } = renderModal("perspective", null);
		await stillLoaded();
		fireEvent.click(screen.getByRole("button", { name: "1:1" }));
		fireEvent.change(screen.getByRole("slider"), { target: { value: "10" } });
		fireEvent.click(apply());
		expect(onApply).toHaveBeenCalledTimes(1);
		expect(onApply).toHaveBeenCalledWith({
			perspective: {
				corners: [
					{ x: 0.15, y: 0.15 },
					{ x: 0.85, y: 0.15 },
					{ x: 0.85, y: 0.85 },
					{ x: 0.15, y: 0.85 },
				],
				aspect: 1,
				margin: 0.1,
			},
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("arrow keys move the focused handle", async () => {
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		const handle = screen.getByTestId("calibration-handle-0");
		handle.focus();
		// One image pixel right, then ten down.
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
		fireEvent.click(apply());
		const corners = onApply.mock.calls[0][0].perspective.corners;
		expect(corners[0].x).toBeCloseTo(0.15 + 1 / 50, 9);
		expect(corners[0].y).toBeCloseTo(0.15 + 10 / 40, 9);
		expect(corners[1]).toEqual({ x: 0.85, y: 0.15 });
		// The A4 landscape default.
		expect(onApply.mock.calls[0][0].perspective.aspect).toBeCloseTo(297 / 210, 9);
	});

	it("crop mode stores a crop", async () => {
		const { onApply } = renderModal("crop", null);
		await stillLoaded();
		const crop = screen.getByTestId("calibration-crop");
		// Shrink from the right edge, then move right.
		for (let i = 0; i < 20; i++) fireEvent.keyDown(crop, { key: "ArrowLeft", shiftKey: true });
		for (let i = 0; i < 5; i++) fireEvent.keyDown(crop, { key: "ArrowRight" });
		fireEvent.click(apply());
		expect(onApply).toHaveBeenCalledTimes(1);
		const stored = onApply.mock.calls[0][0].crop;
		expect(stored.x).toBeCloseTo(0.05, 9);
		expect(stored.y).toBe(0);
		expect(stored.width).toBeCloseTo(0.8, 9);
		expect(stored.height).toBe(1);
	});

	it("cancel stores nothing", async () => {
		const { onApply, onClose } = renderModal("perspective", null);
		await stillLoaded();
		fireEvent.keyDown(screen.getByTestId("calibration-handle-2"), { key: "ArrowLeft" });
		fireEvent.click(screen.getByRole("button", { name: "common.actions.cancel" }));
		expect(onClose).toHaveBeenCalled();
		expect(onApply).not.toHaveBeenCalled();
	});

	it("an invalid free ratio says why and marks the field", async () => {
		renderModal("perspective", null);
		await stillLoaded();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.formats.free" }));
		const input = screen.getByRole("spinbutton");
		expect(input).toHaveAttribute("aria-invalid", "false");
		fireEvent.change(input, { target: { value: "50" } });
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("alert")).toHaveTextContent("dialogs.cameraCalibration.invalidRatio");
		expect(apply()).toBeDisabled();
	});

	it("a drag ends on pointercancel and its listeners go with the dialog", async () => {
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		const { unmount } = render(
			<CameraCalibrationModal
				open
				camera={CAMERA}
				mode="crop"
				initial={null}
				onApply={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await stillLoaded();
		const frame = screen.getByTestId("calibration-frame");
		vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 80));
		const crop = screen.getByTestId("calibration-crop");
		const dragTypes = ["pointermove", "pointerup", "pointercancel"];
		// The drag's own listeners: added after `from`, still registered unless removed since.
		const dragListeners = (from: number) =>
			add.mock.calls.slice(from).filter(([type]) => dragTypes.includes(type));
		const stillAttached = (from: number) =>
			dragListeners(from).filter(
				([type, fn]) => !remove.mock.calls.some(([t, f]) => t === type && f === fn),
			).length;

		let from = add.mock.calls.length;
		fireEvent.pointerDown(crop, { clientX: 10, clientY: 10 });
		expect(dragListeners(from)).toHaveLength(3);
		fireEvent(window, new Event("pointercancel"));
		expect(stillAttached(from)).toBe(0);

		// A drag still running when the dialog goes away is ended with it.
		from = add.mock.calls.length;
		fireEvent.pointerDown(crop, { clientX: 10, clientY: 10 });
		expect(stillAttached(from)).toBe(3);
		unmount();
		expect(stillAttached(from)).toBe(0);
	});

	const FOUND = [
		{ x: 0.2, y: 0.25 },
		{ x: 0.8, y: 0.2 },
		{ x: 0.85, y: 0.9 },
		{ x: 0.1, y: 0.8 },
	];
	// A desk frame seen straight on: 0.6 x 0.6 of the image, 2:1 and 1 m wide in reality.
	const PLANE = {
		corners: [
			{ x: 0.2, y: 0.2 },
			{ x: 0.8, y: 0.2 },
			{ x: 0.8, y: 0.8 },
			{ x: 0.2, y: 0.8 },
		] as [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		],
		aspect: 2,
		widthMm: 1000,
	};
	const detect = () =>
		fireEvent.click(
			screen.getByRole("button", { name: "dialogs.cameraCalibration.detectMarkers" }),
		);

	function expectedPerspective(aspect: number) {
		const base = { corners: PLANE.corners, aspect: PLANE.aspect };
		const view = planeView(base);
		const box = view && perspectiveToCrop(view, base);
		if (!view || !box) throw new Error("test plane must be usable");
		return cropToPerspective(view, fitCrop(view.aspect, aspect, box));
	}

	it("detect without a plane puts the handles on the markers", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: null });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(detectMarkedArea).toHaveBeenCalledWith(IMAGE);
		expect(screen.getByRole("status")).toHaveTextContent("dialogs.cameraCalibration.noPlane");
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
		fireEvent.click(apply());
		expect(onApply.mock.calls[0][0].perspective.corners).toEqual(FOUND);
	});

	it("detect shows the rectified desk with a 16:9 crop", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(screen.getByRole("status")).toHaveTextContent("dialogs.cameraCalibration.planeFound");
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
		expect(screen.queryByTestId("calibration-handle-0")).toBeNull();
		fireEvent.click(apply());
		const stored = onApply.mock.calls[0][0].perspective;
		const expected = expectedPerspective(16 / 9);
		expect(stored.aspect).toBeCloseTo(16 / 9, 9);
		expect(stored.margin).toBeUndefined();
		stored.corners.forEach((c: { x: number; y: number }, i: number) => {
			expect(c.x).toBeCloseTo(expected?.corners[i].x ?? Number.NaN, 9);
			expect(c.y).toBeCloseTo(expected?.corners[i].y ?? Number.NaN, 9);
		});
	});

	it("a format refits the crop on the desk", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		fireEvent.click(screen.getByRole("button", { name: "9:16" }));
		fireEvent.click(apply());
		expect(onApply.mock.calls[0][0].perspective.aspect).toBeCloseTo(9 / 16, 9);
	});

	it("Shift + arrows resize a fixed-format crop on the desk: left shrinks, right grows", async () => {
		// The stored crop's width in the image, after detection and `presses` Shift + `key`.
		const widthAfter = async (key: string | null, presses: number) => {
			detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
			const { onApply } = renderModal("perspective", null);
			await stillLoaded();
			detect();
			const crop = screen.getByTestId("calibration-crop");
			for (let i = 0; key && i < presses; i++) fireEvent.keyDown(crop, { key, shiftKey: true });
			fireEvent.click(apply());
			const stored = onApply.mock.calls[0][0].perspective;
			expect(stored.aspect).toBeCloseTo(16 / 9, 9);
			cleanup();
			return Math.hypot(
				stored.corners[1].x - stored.corners[0].x,
				stored.corners[1].y - stored.corners[0].y,
			);
		};
		const initial = await widthAfter(null, 0);
		expect(await widthAfter("ArrowLeft", 5)).toBeLessThan(initial - 1e-3);
		expect(await widthAfter("ArrowUp", 5)).toBeLessThan(initial - 1e-3);
		// Grow after shrinking, so the crop has room on any default.
		const shrunk = await widthAfter("ArrowLeft", 10);
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		const crop = screen.getByTestId("calibration-crop");
		for (let i = 0; i < 10; i++) fireEvent.keyDown(crop, { key: "ArrowLeft", shiftKey: true });
		for (let i = 0; i < 3; i++) fireEvent.keyDown(crop, { key: "ArrowRight", shiftKey: true });
		fireEvent.click(apply());
		const grown = onApply.mock.calls[0][0].perspective;
		expect(grown.aspect).toBeCloseTo(16 / 9, 9);
		expect(
			Math.hypot(grown.corners[1].x - grown.corners[0].x, grown.corners[1].y - grown.corners[0].y),
		).toBeGreaterThan(shrunk + 1e-3);
	});

	it("shows the crop's real size after detection", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(screen.getByText("dialogs.cameraCalibration.cropSize")).toBeInTheDocument();
	});

	it("hand mode brings back the four handles", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		renderModal("perspective", null);
		await stillLoaded();
		detect();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.handMode" }));
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.planeMode" }));
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
	});

	it("a stored correction reopens on the desk and applies unchanged", async () => {
		const stored = { corners: PLANE.corners, aspect: 2 };
		const { onApply } = renderModal("perspective", { perspective: stored });
		await stillLoaded();
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
		fireEvent.click(apply());
		const out = onApply.mock.calls[0][0].perspective;
		expect(out.aspect).toBeCloseTo(2, 9);
		out.corners.forEach((c: { x: number; y: number }, i: number) => {
			expect(c.x).toBeCloseTo(stored.corners[i].x, 9);
			expect(c.y).toBeCloseTo(stored.corners[i].y, 9);
		});
	});

	it("a stored correction with a margin still opens with the four handles", async () => {
		renderModal("perspective", { perspective: { corners: PLANE.corners, aspect: 2, margin: 0.1 } });
		await stillLoaded();
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
	});

	it("detect without four markers shows the message and keeps the handles", async () => {
		detectMarkedArea.mockReturnValueOnce(null);
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		fireEvent.click(
			screen.getByRole("button", { name: "dialogs.cameraCalibration.detectMarkers" }),
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"dialogs.cameraCalibration.markersNotFound",
		);
		fireEvent.click(apply());
		expect(onApply.mock.calls[0][0].perspective.corners).toEqual([
			{ x: 0.15, y: 0.15 },
			{ x: 0.85, y: 0.15 },
			{ x: 0.85, y: 0.85 },
			{ x: 0.15, y: 0.85 },
		]);
	});

	it("the marker message goes away once a handle moves", async () => {
		detectMarkedArea.mockReturnValueOnce(null);
		renderModal("perspective", null);
		await stillLoaded();
		const detect = () =>
			fireEvent.click(
				screen.getByRole("button", { name: "dialogs.cameraCalibration.detectMarkers" }),
			);
		detect();
		expect(screen.getByRole("status")).toHaveTextContent(
			"dialogs.cameraCalibration.markersNotFound",
		);
		fireEvent.keyDown(screen.getByTestId("calibration-handle-1"), { key: "ArrowLeft" });
		expect(screen.getByRole("status")).toBeEmptyDOMElement();

		// A drag that starts clears it too, before the pointer even moves.
		detectMarkedArea.mockReturnValueOnce(null);
		detect();
		expect(screen.getByRole("status")).toHaveTextContent(
			"dialogs.cameraCalibration.markersNotFound",
		);
		const frame = screen.getByTestId("calibration-frame");
		vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 80));
		// Corner 0 sits at 15 % / 15 % of the frame.
		fireEvent.pointerDown(frame, { clientX: 15, clientY: 12 });
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
		fireEvent(window, new Event("pointerup"));
	});

	it("print hands the translated texts to the sheet", async () => {
		renderModal("perspective", null);
		await stillLoaded();
		fireEvent.click(
			screen.getByRole("button", { name: "dialogs.cameraCalibration.printMarkerSheet" }),
		);
		expect(printMarkerSheet).toHaveBeenCalledWith({
			instruction: "dialogs.cameraCalibration.markerSheetInstruction",
			labels: [
				"0 – dialogs.cameraCalibration.corners.topLeft",
				"1 – dialogs.cameraCalibration.corners.topRight",
				"2 – dialogs.cameraCalibration.corners.bottomRight",
				"3 – dialogs.cameraCalibration.corners.bottomLeft",
			],
		});
	});

	it("reset removes the stored perspective", async () => {
		const { onApply } = renderModal("perspective", {
			perspective: {
				corners: [
					{ x: 0.1, y: 0.1 },
					{ x: 0.9, y: 0.1 },
					{ x: 0.9, y: 0.9 },
					{ x: 0.1, y: 0.9 },
				],
				aspect: 2,
			},
		});
		await stillLoaded();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.reset" }));
		expect(onApply).toHaveBeenCalledWith({ perspective: undefined });
	});

	it("perspective mode says a stored crop is ignored", async () => {
		renderModal("perspective", { crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } });
		await stillLoaded();
		expect(screen.getByText("dialogs.cameraCalibration.cropIgnored")).toBeInTheDocument();
	});

	it("says nothing about the crop when there is none", async () => {
		renderModal("perspective", null);
		await stillLoaded();
		expect(screen.queryByText("dialogs.cameraCalibration.cropIgnored")).toBeNull();
	});

	it("crop mode does not show the perspective note", async () => {
		renderModal("crop", { crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } });
		await stillLoaded();
		expect(screen.queryByText("dialogs.cameraCalibration.cropIgnored")).toBeNull();
	});

	it("the caller can report camera 1's crop, which lives outside the settings", async () => {
		render(
			<CameraCalibrationModal
				open
				camera={{ ...CAMERA, index: 0 }}
				mode="perspective"
				initial={null}
				hasCrop
				onApply={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await stillLoaded();
		expect(screen.getByText("dialogs.cameraCalibration.cropIgnored")).toBeInTheDocument();
	});
});
