// The crop on the rectified desk. A "base" is a CameraPerspective whose corners are a true
// rectangle on the plane (from the markers, or a stored correction). The dialog shows a "view":
// the base grown about its centre, still a true rectangle. The user's crop is a CropRegion in
// fractions of that view; turning it back into four image corners gives a perspective that is
// rectangular on the desk whatever the crop's format.

import type { CameraPerspective, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "@/lib/cameraPerspective";
import { invert3 } from "@/lib/planeMeasure";
import { MIN_CROP, mapThrough } from "./calibrationGeometry";

/** How much larger than the base the view is, on each side's length. */
export const PLANE_VIEW_GROW = 1.6;
/** A view corner closer to the horizon than this (homogeneous w) is pulled back. */
const MIN_W = 0.05;
const GROW_STEPS = 6;

type Corners = CameraPerspective["corners"];

function cornersOf(h: number[], x0: number, y0: number, x1: number, y1: number): Corners | null {
	const pts = [
		mapThrough(h, x0, y0),
		mapThrough(h, x1, y0),
		mapThrough(h, x1, y1),
		mapThrough(h, x0, y1),
	];
	if (pts.some((p) => p === null)) return null;
	const [a, b, c, d] = pts as NonNullable<(typeof pts)[number]>[];
	return [a, b, c, d];
}

/**
 * The base grown `grow` times about its centre — less when that would reach past the horizon,
 * never less than the base itself. Null when the base is not a usable quad.
 */
export function planeView(
	base: CameraPerspective,
	grow = PLANE_VIEW_GROW,
): CameraPerspective | null {
	const h = homographyFromUnitSquare(base.corners);
	if (!h) return null;
	for (let k = GROW_STEPS; k >= 0; k--) {
		const g = 1 + ((grow - 1) * k) / GROW_STEPS;
		const lo = (1 - g) / 2;
		const hi = (1 + g) / 2;
		const ws = [
			[lo, lo],
			[hi, lo],
			[hi, hi],
			[lo, hi],
		].map(([u, v]) => h[6] * u + h[7] * v + h[8]);
		if (ws.some((w) => w <= MIN_W)) continue;
		const corners = cornersOf(h, lo, lo, hi, hi);
		if (corners) return { corners, aspect: base.aspect };
	}
	return null;
}

/** The view's crop as a perspective: four image corners and the crop's real proportions. */
export function cropToPerspective(
	view: CameraPerspective,
	crop: CropRegion,
): CameraPerspective | null {
	const h = homographyFromUnitSquare(view.corners);
	if (!h) return null;
	const corners = cornersOf(h, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
	return corners ? { corners, aspect: cropAspectOf(view.aspect, crop) } : null;
}

/** Where a perspective's corners sit in the view, as the rectangle that holds them. */
export function perspectiveToCrop(
	view: CameraPerspective,
	p: CameraPerspective,
): CropRegion | null {
	const h = homographyFromUnitSquare(view.corners);
	const inv = h ? invert3(h) : null;
	if (!inv) return null;
	const uv = p.corners.map((c) => mapThrough(inv, c.x, c.y));
	if (uv.some((q) => q === null)) return null;
	const q = uv as NonNullable<(typeof uv)[number]>[];
	const x0 = Math.min(...q.map((c) => c.x));
	const x1 = Math.max(...q.map((c) => c.x));
	const y0 = Math.min(...q.map((c) => c.y));
	const y1 = Math.max(...q.map((c) => c.y));
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Real width ÷ height of a crop in a view of real aspect `viewAspect`. */
export function cropAspectOf(viewAspect: number, crop: CropRegion): number {
	return (viewAspect * crop.width) / crop.height;
}

/** The largest crop of real aspect `cropAspect` inside `box`, centred; the box itself when free. */
export function fitCrop(
	viewAspect: number,
	cropAspect: number | null,
	box: CropRegion,
): CropRegion {
	if (cropAspect === null) return { ...box };
	// In view fractions the crop is k times as tall as it is wide.
	const k = viewAspect / cropAspect;
	const width = Math.min(box.width, box.height / k);
	const height = width * k;
	return {
		x: box.x + (box.width - width) / 2,
		y: box.y + (box.height - height) / 2,
		width,
		height,
	};
}

export type CropCorner = "nw" | "ne" | "sw" | "se";

/**
 * `start` resized from `corner` by (dx, dy), its real aspect held and the opposite corner fixed:
 * the size follows whichever axis the pointer moved further along, inside the view.
 */
export function resizeCropLocked(
	start: CropRegion,
	corner: CropCorner,
	dx: number,
	dy: number,
	viewAspect: number,
	cropAspect: number,
): CropRegion {
	const k = viewAspect / cropAspect;
	const east = corner.endsWith("e");
	const south = corner.startsWith("s");
	const anchorX = east ? start.x : start.x + start.width;
	const anchorY = south ? start.y : start.y + start.height;
	const fromX = start.width + (east ? dx : -dx);
	const fromY = (start.height + (south ? dy : -dy)) / k;
	const maxWidth = Math.min(east ? 1 - anchorX : anchorX, (south ? 1 - anchorY : anchorY) / k);
	const minWidth = Math.max(MIN_CROP, MIN_CROP / k);
	const width = Math.min(maxWidth, Math.max(minWidth, Math.max(fromX, fromY)));
	const height = width * k;
	return {
		x: east ? anchorX : anchorX - width,
		y: south ? anchorY : anchorY - height,
		width,
		height,
	};
}

/** True when a corner of `p` lies outside the camera image (the picture turns black there). */
export function cropLeavesImage(p: CameraPerspective | null): boolean {
	if (!p) return false;
	const eps = 0.002;
	return p.corners.some((c) => c.x < -eps || c.y < -eps || c.x > 1 + eps || c.y > 1 + eps);
}
