import { describe, expect, it } from "vitest";
import type { CameraLayoutRegion } from "@/components/video-editor/types";
import type { CameraLayoutContext } from "@/lib/cameraLayoutTemplates";
import {
	inwardCorner,
	MIN_SLOT_SHORT_SIDE_FRAC,
	moveSlotRect,
	pipPlacesOf,
	resizeSlotRect,
} from "./layoutSlotDrag";

const FRAME = { width: 1920, height: 1080 };
/** Pixel width / height of a rect in frame fractions. */
const pixelAspect = (r: { width: number; height: number }) =>
	(r.width * FRAME.width) / (r.height * FRAME.height);

describe("moveSlotRect", () => {
	it("moves inside the frame", () => {
		const start = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
		expect(moveSlotRect(start, 0.1, -0.1)).toEqual({ x: 0.6, y: 0.4, width: 0.2, height: 0.2 });
		// Past an edge, it stops flush against it.
		expect(moveSlotRect(start, 0.9, 0.9)).toEqual({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 });
		expect(moveSlotRect(start, -0.9, -0.9)).toEqual({ x: 0, y: 0, width: 0.2, height: 0.2 });
	});

	it("brings a rect stored outside the frame back in", () => {
		const moved = moveSlotRect({ x: 1.2, y: -0.3, width: 0.2, height: 0.2 }, 0, 0);
		expect(moved).toEqual({ x: 0.8, y: 0, width: 0.2, height: 0.2 });
	});
});

describe("resizeSlotRect", () => {
	const start = { x: 0.5, y: 0.5, width: 0.2, height: (0.2 * 1920) / (16 / 9) / 1080 };

	it("resize keeps the box aspect", () => {
		const next = resizeSlotRect(start, "se", 0.1, 0.02, 16 / 9, FRAME);
		expect(next.x).toBeCloseTo(0.5);
		expect(next.y).toBeCloseTo(0.5);
		expect(next.width).toBeGreaterThan(start.width);
		expect(pixelAspect(next)).toBeCloseTo(16 / 9);
	});

	it("keeps the opposite corner fixed when dragging the top-left handle", () => {
		const next = resizeSlotRect(start, "nw", -0.1, -0.1, 16 / 9, FRAME);
		expect(next.x + next.width).toBeCloseTo(start.x + start.width);
		expect(next.y + next.height).toBeCloseTo(start.y + start.height);
		expect(pixelAspect(next)).toBeCloseTo(16 / 9);
	});

	it("a circle stays square", () => {
		const square = { x: 0.6, y: 0.5, width: 0.1, height: (0.1 * 1920) / 1080 };
		const next = resizeSlotRect(square, "nw", -0.05, -0.2, 1, FRAME);
		expect(pixelAspect(next)).toBeCloseTo(1);
		expect(next.width).toBeGreaterThan(square.width);
	});

	it("shrinks on a single-axis inward drag", () => {
		const next = resizeSlotRect(start, "se", -0.05, 0, 16 / 9, FRAME);
		expect(next.width).toBeCloseTo(start.width - 0.05);
		expect(pixelAspect(next)).toBeCloseTo(16 / 9);
		const vertical = resizeSlotRect(start, "se", 0, -0.02, 16 / 9, FRAME);
		expect(vertical.height).toBeLessThan(start.height);
	});

	it("clamps to a minimum size", () => {
		const next = resizeSlotRect(start, "se", -0.5, -0.5, 16 / 9, FRAME);
		const shortSidePx = Math.min(next.width * FRAME.width, next.height * FRAME.height);
		expect(shortSidePx).toBeCloseTo(MIN_SLOT_SHORT_SIDE_FRAC * FRAME.height);
		expect(pixelAspect(next)).toBeCloseTo(16 / 9);
	});

	it("stops at the frame edge without losing the aspect", () => {
		const next = resizeSlotRect(start, "se", 1, 1, 16 / 9, FRAME);
		expect(next.x + next.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(next.y + next.height).toBeLessThanOrEqual(1 + 1e-9);
		expect(pixelAspect(next)).toBeCloseTo(16 / 9);
	});
});

describe("inwardCorner", () => {
	it("points the handle towards the middle of the frame", () => {
		expect(inwardCorner({ x: 0.7, y: 0.7, width: 0.2, height: 0.2 })).toBe("nw");
		expect(inwardCorner({ x: 0.1, y: 0.7, width: 0.2, height: 0.2 })).toBe("ne");
		expect(inwardCorner({ x: 0.7, y: 0.1, width: 0.2, height: 0.2 })).toBe("sw");
		expect(inwardCorner({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 })).toBe("se");
	});
});

describe("pipPlacesOf", () => {
	const ctx: CameraLayoutContext = {
		frame: FRAME,
		cameraAspect: () => 16 / 9,
		pipShape: "rounded",
		pipRadiusFrac: 0.1,
	};

	it("lists only the PiP places, with their slot index", () => {
		const region: CameraLayoutRegion = {
			id: "l1",
			startMs: 0,
			endMs: 1000,
			template: "camera-full-pip",
			slots: [{ camera: 1 }, { camera: 0 }, { camera: 2 }],
		};
		const places = pipPlacesOf(region, ctx);
		expect(places.map((p) => [p.slotIndex, p.camera])).toEqual([
			[1, 0],
			[2, 2],
		]);
		expect(places[0].aspect).toBeCloseTo(16 / 9);
	});

	it("locks circle and square places to a square", () => {
		const region: CameraLayoutRegion = {
			id: "l1",
			startMs: 0,
			endMs: 1000,
			template: "screen-pip",
			slots: [{ camera: 0 }],
		};
		expect(pipPlacesOf(region, { ...ctx, pipShape: "circle" })[0].aspect).toBe(1);
	});

	it("has no place for a frame-filling template", () => {
		const region: CameraLayoutRegion = {
			id: "l1",
			startMs: 0,
			endMs: 1000,
			template: "side-by-side",
			slots: [{ camera: 0 }, { camera: 1 }],
		};
		expect(pipPlacesOf(region, ctx)).toEqual([]);
	});
});
