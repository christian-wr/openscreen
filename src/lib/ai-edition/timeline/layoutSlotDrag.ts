// Geometry behind dragging a layout section's camera places in the preview: which places can
// be moved (the PiPs), and how a move or a corner resize keeps a place inside the frame, above
// a minimum size and at its box's proportions. Everything is in output-frame fractions; the
// frame's pixel size only enters where proportions are measured in pixels.

import type { CameraLayoutRegion, NormalizedRect } from "@/components/video-editor/types";
import {
	type CameraLayoutContext,
	type ResolvedCameraLayer,
	resolveCameraLayout,
	slotFillsFrame,
} from "@/lib/cameraLayoutTemplates";

/** The smallest a place may get: its short side, as a fraction of the frame's short side. */
export const MIN_SLOT_SHORT_SIDE_FRAC = 0.05;

export type SlotCorner = "nw" | "ne" | "sw" | "se";

type FrameSize = { width: number; height: number };

/** A PiP place of a section, as the preview offers it for dragging. */
export interface PipPlace {
	/** Index into `region.slots` (not into the resolved layers, which list frame-fillers first). */
	slotIndex: number;
	camera: number;
	rect: NormalizedRect;
	shape: ResolvedCameraLayer["shape"];
	/** Pixel width / height the place keeps while resized: 1 for a circle or square. */
	aspect: number;
}

/** The section's PiP places, where the compositor draws them. Frame-filling places have none. */
export function pipPlacesOf(region: CameraLayoutRegion, ctx: CameraLayoutContext): PipPlace[] {
	const pipSlots = region.slots
		.map((_, index) => index)
		.filter((index) => !slotFillsFrame(region.template, index));
	// The resolver lists PiPs after the frame-fillers, each in slot order.
	const pipLayers = resolveCameraLayout(region, ctx).filter((layer) => !layer.fillsFrame);
	return pipLayers.map((layer, k) => {
		const squareBox = layer.shape === "circle" || layer.shape === "square";
		const cameraAspect = ctx.cameraAspect(layer.camera);
		const safeAspect = Number.isFinite(cameraAspect) && cameraAspect > 0 ? cameraAspect : 16 / 9;
		return {
			slotIndex: pipSlots[k] ?? k,
			camera: layer.camera,
			rect: layer.rect,
			shape: layer.shape,
			aspect: squareBox ? 1 : safeAspect,
		};
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** The rect no larger than the frame and inside it (a stored rect may reach past it). */
function insideFrame(rect: NormalizedRect): NormalizedRect {
	const width = Math.min(rect.width, 1);
	const height = Math.min(rect.height, 1);
	return {
		x: clamp(rect.x, 0, 1 - width),
		y: clamp(rect.y, 0, 1 - height),
		width,
		height,
	};
}

/** `start` moved by (dx, dy) frame fractions, stopping flush against the frame's edges. */
export function moveSlotRect(start: NormalizedRect, dx: number, dy: number): NormalizedRect {
	const fitted = insideFrame(start);
	return insideFrame({ ...fitted, x: fitted.x + dx, y: fitted.y + dy });
}

/**
 * `start` resized by dragging its `corner` by (dx, dy) frame fractions. The opposite corner
 * stays put; the size follows whichever axis the pointer pulled further, at `aspect` (pixel
 * width / height), between the minimum size and the frame's edges.
 */
export function resizeSlotRect(
	start: NormalizedRect,
	corner: SlotCorner,
	dx: number,
	dy: number,
	aspect: number,
	frame: FrameSize,
): NormalizedRect {
	const rect = insideFrame(start);
	const signX = corner === "ne" || corner === "se" ? 1 : -1;
	const signY = corner === "sw" || corner === "se" ? 1 : -1;
	const fixedX = signX > 0 ? rect.x : rect.x + rect.width;
	const fixedY = signY > 0 ? rect.y : rect.y + rect.height;
	// Widths in pixels: the one the pointer asks for along each axis.
	const fromX = (rect.width + signX * dx) * frame.width;
	const fromY = (rect.height + signY * dy) * frame.height * aspect;
	const minWidth =
		MIN_SLOT_SHORT_SIDE_FRAC * Math.min(frame.width, frame.height) * Math.max(1, aspect);
	const roomX = signX > 0 ? 1 - fixedX : fixedX;
	const roomY = signY > 0 ? 1 - fixedY : fixedY;
	const maxWidth = Math.min(roomX * frame.width, roomY * frame.height * aspect);
	// The frame wins over the minimum: a place never leaves it.
	const widthPx = Math.min(Math.max(fromX, fromY, minWidth), maxWidth);
	const width = widthPx / frame.width;
	const height = widthPx / aspect / frame.height;
	return {
		x: signX > 0 ? fixedX : fixedX - width,
		y: signY > 0 ? fixedY : fixedY - height,
		width,
		height,
	};
}

/** The corner of `rect` that faces the middle of the frame: where its resize handle sits. */
export function inwardCorner(rect: NormalizedRect): SlotCorner {
	const right = rect.x + rect.width / 2 < 0.5;
	const bottom = rect.y + rect.height / 2 < 0.5;
	if (bottom) return right ? "se" : "sw";
	return right ? "ne" : "nw";
}
