// Real-world size of a quad on a flat surface, from squares of known size lying on the same
// surface — the printed markers. Each square's homography carries the image of the plane's
// circular points (h1 + i·h2); every square on one plane sees the same pair, so averaging them
// over all markers gives a metric rectification without knowing the camera (Hartley &
// Zisserman, "metric rectification from the circular points"). Lengths measured after that
// rectification are true up to one scale, which the markers' printed side fixes.

import type { CameraPerspective } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "./cameraPerspective";

type Corners = CameraPerspective["corners"];
interface Pt {
	x: number;
	y: number;
}

/** A complex 3-vector: re + i·im. */
interface CVec {
	re: [number, number, number];
	im: [number, number, number];
}

export interface PlaneSize {
	widthMm: number;
	heightMm: number;
}

function conj(v: CVec): CVec {
	return { re: v.re, im: [-v.im[0], -v.im[1], -v.im[2]] };
}

/** <a, b> = Σ conj(a_k)·b_k. */
function dot(a: CVec, b: CVec): { re: number; im: number } {
	let re = 0;
	let im = 0;
	for (let k = 0; k < 3; k++) {
		re += a.re[k] * b.re[k] + a.im[k] * b.im[k];
		im += a.re[k] * b.im[k] - a.im[k] * b.re[k];
	}
	return { re, im };
}

function scale(v: CVec, s: { re: number; im: number }): CVec {
	const re = [0, 1, 2].map((k) => v.re[k] * s.re - v.im[k] * s.im);
	const im = [0, 1, 2].map((k) => v.re[k] * s.im + v.im[k] * s.re);
	return { re: re as CVec["re"], im: im as CVec["im"] };
}

function distanceSq(a: CVec, b: CVec): number {
	let sum = 0;
	for (let k = 0; k < 3; k++) sum += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2;
	return sum;
}

/** `v` rescaled (complex) onto `ref`, and how far it stays from it. */
function alignTo(v: CVec, ref: CVec): { aligned: CVec; residual: number } {
	const vv = dot(v, v).re;
	const vr = dot(v, ref);
	const aligned = scale(v, { re: vr.re / vv, im: vr.im / vv });
	return { aligned, residual: distanceSq(aligned, ref) };
}

/** The imaged circular point of one square: columns h1 + i·h2 of its homography. */
function circularPoint(square: Corners): CVec | null {
	const h = homographyFromUnitSquare(square);
	if (!h) return null;
	const v: CVec = { re: [h[0], h[3], h[6]], im: [h[1], h[4], h[7]] };
	const norm = Math.sqrt(dot(v, v).re);
	if (!(norm > 0)) return null;
	return scale(v, { re: 1 / norm, im: 0 });
}

/** Inverse of a row-major 3x3 matrix; null when singular. */
export function invert3(m: number[]): number[] | null {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
	return [
		A / det,
		(c * h - b * i) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		(c * d - a * f) / det,
		C / det,
		(b * g - a * h) / det,
		(a * e - b * d) / det,
	];
}

function apply(m: number[], p: Pt): Pt | null {
	const w = m[6] * p.x + m[7] * p.y + m[8];
	if (Math.abs(w) < 1e-12) return null;
	return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

function length(a: Pt, b: Pt): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Image -> metric plane (similarity-correct), from the squares; `anchor` must be off the horizon. */
function rectifyingHomography(squares: Corners[], anchor: Pt): number[] | null {
	const points = squares.map(circularPoint).filter((v): v is CVec => v !== null);
	if (points.length === 0) return null;
	// The pair is only defined up to a complex factor and conjugation (a square traced the other
	// way round sees the conjugate), so each is turned onto the first before summing.
	const ref = points[0];
	const sum: CVec = { re: [0, 0, 0], im: [0, 0, 0] };
	for (const v of points) {
		const direct = alignTo(v, ref);
		const mirrored = alignTo(conj(v), ref);
		const { aligned } = direct.residual <= mirrored.residual ? direct : mirrored;
		for (let k = 0; k < 3; k++) {
			sum.re[k] += aligned.re[k];
			sum.im[k] += aligned.im[k];
		}
	}
	// M = [re | im | anchor] maps the metric plane onto the image with (1, ±i, 0) landing on the
	// circular points, for any anchor off the vanishing line.
	return invert3([
		sum.re[0],
		sum.im[0],
		anchor.x,
		sum.re[1],
		sum.im[1],
		anchor.y,
		sum.re[2],
		sum.im[2],
		1,
	]);
}

/** Millimetres per plane unit: the squares' mean side against their printed side. */
function mmPerUnitOf(toPlane: number[], squares: Corners[], sideMm: number): number | null {
	let sideSum = 0;
	let sideCount = 0;
	for (const square of squares) {
		const r = square.map((p) => apply(toPlane, p));
		if (r.some((p) => p === null)) continue;
		const q = r as Pt[];
		for (let k = 0; k < 4; k++) sideSum += length(q[k], q[(k + 1) % 4]);
		sideCount += 4;
	}
	return sideCount > 0 && sideSum > 0 ? sideMm / (sideSum / sideCount) : null;
}

/**
 * The size of `quad` (TL, TR, BR, BL; width = mean of top and bottom, height = mean of the
 * sides) on the plane that holds `squares`, each a square `sideMm` wide given by its four image
 * corners in a consistent winding. All points in one image coordinate system. Null when the
 * squares do not pin the plane down (degenerate corners, a singular rectification).
 */
export function measureOnPlane(
	squares: Corners[],
	sideMm: number,
	quad: Corners,
): PlaneSize | null {
	const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
	const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
	const toPlane = rectifyingHomography(squares, { x: cx, y: cy });
	if (!toPlane) return null;

	const rectify = (pts: readonly Pt[]) => pts.map((p) => apply(toPlane, p));
	const mmPerUnit = mmPerUnitOf(toPlane, squares, sideMm);
	const corners = rectify(quad);
	if (mmPerUnit === null || corners.some((p) => p === null)) return null;
	const [tl, tr, br, bl] = corners as Pt[];
	const widthMm = ((length(tl, tr) + length(bl, br)) / 2) * mmPerUnit;
	const heightMm = ((length(tl, bl) + length(tr, br)) / 2) * mmPerUnit;
	if (!(widthMm > 0 && heightMm > 0 && Number.isFinite(widthMm + heightMm))) return null;
	return { widthMm, heightMm };
}

/** A true rectangle on the plane, as the image sees it. */
export interface PlaneRect {
	/** Its image corners TL, TR, BR, BL, in the caller's image coordinates. */
	corners: Corners;
	/** Real width ÷ height. */
	aspect: number;
	/** Real width in millimetres. */
	widthMm: number;
}

/**
 * The rectangle on the plane that just holds the four inner corners, its top edge parallel to
 * inner[0] -> inner[1]: a frame that is rectangular on the desk however the markers lie. Null
 * when the squares do not pin the plane down.
 */
export function markerPlaneRect(
	squares: Corners[],
	sideMm: number,
	inner: Corners,
): PlaneRect | null {
	const anchor = {
		x: inner.reduce((s, p) => s + p.x, 0) / 4,
		y: inner.reduce((s, p) => s + p.y, 0) / 4,
	};
	const toPlane = rectifyingHomography(squares, anchor);
	const fromPlane = toPlane ? invert3(toPlane) : null;
	if (!toPlane || !fromPlane) return null;
	const mmPerUnit = mmPerUnitOf(toPlane, squares, sideMm);
	const onPlane = inner.map((p) => apply(toPlane, p));
	if (mmPerUnit === null || onPlane.some((p) => p === null)) return null;
	const p = onPlane as Pt[];

	// Local frame: x along marker 0 -> marker 1. The rectification may mirror the plane; marker 3
	// (bottom-left) must end up below marker 0, so y is flipped when it is not.
	const theta = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const rotated = p.map((q) => ({ x: q.x * cos + q.y * sin, y: -q.x * sin + q.y * cos }));
	const flip = rotated[3].y < rotated[0].y ? -1 : 1;
	const local = rotated.map((q) => ({ x: q.x, y: q.y * flip }));
	const minX = Math.min(...local.map((q) => q.x));
	const maxX = Math.max(...local.map((q) => q.x));
	const minY = Math.min(...local.map((q) => q.y));
	const maxY = Math.max(...local.map((q) => q.y));
	const w = maxX - minX;
	const h = maxY - minY;
	if (!(w > 0 && h > 0)) return null;

	const toImage = (q: Pt) => {
		const y = q.y * flip;
		return apply(fromPlane, { x: q.x * cos - y * sin, y: q.x * sin + y * cos });
	};
	const corners = [
		{ x: minX, y: minY },
		{ x: maxX, y: minY },
		{ x: maxX, y: maxY },
		{ x: minX, y: maxY },
	].map(toImage);
	if (corners.some((q) => q === null)) return null;
	const [c0, c1, c2, c3] = corners as Pt[];
	return { corners: [c0, c1, c2, c3], aspect: w / h, widthMm: w * mmPerUnit };
}
