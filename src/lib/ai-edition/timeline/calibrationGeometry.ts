// Pure geometry behind the camera calibration dialog: which handle a pointer grabs, what the
// loupe magnifies, whether a quad can be rectified, how a crop stays inside the frame, and the
// rectified preview sampled through the homography. Corners and crops are normalized (0..1 of
// the camera image); hit-tests and the loupe work in pixels of whatever space the caller uses.

import type { CameraPerspective, CameraPoint, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare, perspectiveMatrix } from "@/lib/cameraPerspective";

export type Corners = CameraPerspective["corners"];

/** Corners a fresh calibration starts from: a rectangle inset from the image's edges. */
export function insetCorners(inset = 0.15): Corners {
	return [
		{ x: inset, y: inset },
		{ x: 1 - inset, y: inset },
		{ x: 1 - inset, y: 1 - inset },
		{ x: inset, y: 1 - inset },
	];
}

/** Index of the point nearest to `p` within `radius`, or null when none is that close. */
export function nearestHandle(
	points: readonly CameraPoint[],
	p: CameraPoint,
	radius: number,
): number | null {
	let best: number | null = null;
	let bestDist = radius;
	points.forEach((q, i) => {
		const d = Math.hypot(q.x - p.x, q.y - p.y);
		if (d <= bestDist) {
			best = i;
			bestDist = d;
		}
	});
	return best;
}

export interface PixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The image area (pixels) a loupe of `size` px at `zoom`× shows around `center`, shifted so it
 * never leaves the image; an image smaller than the area is shown whole.
 */
export function loupeSourceRect(
	center: CameraPoint,
	imageWidth: number,
	imageHeight: number,
	size: number,
	zoom: number,
): PixelRect {
	const span = size / zoom;
	const width = Math.min(span, imageWidth);
	const height = Math.min(span, imageHeight);
	const x = Math.min(Math.max(center.x - width / 2, 0), imageWidth - width);
	const y = Math.min(Math.max(center.y - height / 2, 0), imageHeight - height);
	return { x, y, width, height };
}

/** True when the four corners can be rectified: convex, not crossed, not collinear. */
export function isValidQuad(corners: Corners): boolean {
	return homographyFromUnitSquare(corners) !== null;
}

/** `p` kept inside the image (0..1 on both axes). */
export function clampPoint(p: CameraPoint): CameraPoint {
	return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

/** Smallest crop side, as a fraction of the image. */
export const MIN_CROP = 0.04;

/** The crop moved and sized back inside the image, no side under `MIN_CROP`. */
export function clampCrop(rect: CropRegion): CropRegion {
	const width = Math.min(1, Math.max(MIN_CROP, rect.width));
	const height = Math.min(1, Math.max(MIN_CROP, rect.height));
	const x = Math.min(1 - width, Math.max(0, rect.x));
	const y = Math.min(1 - height, Math.max(0, rect.y));
	return { x, y, width, height };
}

export interface CropEdges {
	left?: boolean;
	right?: boolean;
	top?: boolean;
	bottom?: boolean;
}

/** `start` with its `edges` moved by (dx, dy), the opposite edges held, kept inside the image. */
export function resizeCrop(
	start: CropRegion,
	edges: CropEdges,
	dx: number,
	dy: number,
): CropRegion {
	let left = start.x;
	let right = start.x + start.width;
	let top = start.y;
	let bottom = start.y + start.height;
	if (edges.left) left = Math.min(Math.max(0, left + dx), right - MIN_CROP);
	if (edges.right) right = Math.max(Math.min(1, right + dx), left + MIN_CROP);
	if (edges.top) top = Math.min(Math.max(0, top + dy), bottom - MIN_CROP);
	if (edges.bottom) bottom = Math.max(Math.min(1, bottom + dy), top + MIN_CROP);
	// An axis no edge moved keeps its exact numbers (no round trip through left/right).
	const horizontal = edges.left || edges.right;
	const vertical = edges.top || edges.bottom;
	return {
		x: horizontal ? left : start.x,
		y: vertical ? top : start.y,
		width: horizontal ? right - left : start.width,
		height: vertical ? bottom - top : start.height,
	};
}

/** `start` moved by (dx, dy) as a whole, its size kept, inside the image. */
export function moveCrop(start: CropRegion, dx: number, dy: number): CropRegion {
	return clampCrop({ ...start, x: start.x + dx, y: start.y + dy });
}

/** True when the crop covers the whole image (stored as "no crop"). */
export function isFullCrop(rect: CropRegion): boolean {
	const eps = 1e-6;
	return rect.x <= eps && rect.y <= eps && rect.width >= 1 - eps && rect.height >= 1 - eps;
}

/** Size of the rectified preview: `longSide` on the longer side, `aspect` = width/height. */
export function previewSize(aspect: number, longSide: number): { width: number; height: number } {
	const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
	return a >= 1
		? { width: longSide, height: Math.max(1, Math.round(longSide / a)) }
		: { width: Math.max(1, Math.round(longSide * a)), height: longSide };
}

/** Where (u, v) of the corrected picture lands in the camera image, normalized; null at infinity. */
export function mapThrough(h: readonly number[], u: number, v: number): CameraPoint | null {
	const w = h[6] * u + h[7] * v + h[8];
	if (Math.abs(w) < 1e-12) return null;
	return { x: (h[0] * u + h[1] * v + h[2]) / w, y: (h[3] * u + h[4] * v + h[5]) / w };
}

export interface RgbaImage {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/**
 * The corrected picture, `width × height` RGBA, nearest-neighbour sampled from `image` through
 * the perspective (margin included). Pixels that fall outside the camera image are black.
 * Null when the quad cannot be rectified.
 */
export function renderRectified(
	image: RgbaImage,
	perspective: CameraPerspective,
	width: number,
	height: number,
): Uint8ClampedArray<ArrayBuffer> | null {
	const h = perspectiveMatrix(perspective);
	if (!h) return null;
	const out = new Uint8ClampedArray(width * height * 4);
	for (let j = 0; j < height; j++) {
		const v = (j + 0.5) / height;
		for (let i = 0; i < width; i++) {
			const o = (j * width + i) * 4;
			out[o + 3] = 255;
			const p = mapThrough(h, (i + 0.5) / width, v);
			if (!p) continue;
			const sx = Math.floor(p.x * image.width);
			const sy = Math.floor(p.y * image.height);
			if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
			const s = (sy * image.width + sx) * 4;
			out[o] = image.data[s];
			out[o + 1] = image.data[s + 1];
			out[o + 2] = image.data[s + 2];
		}
	}
	return out;
}
