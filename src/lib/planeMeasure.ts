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
function invert3(m: number[]): number[] | null {
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

	// M = [re | im | c] maps the metric plane onto the image with (1, ±i, 0) landing on the
	// circular points, for any c off the vanishing line; the quad's centre is such a point.
	const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
	const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
	const toPlane = invert3([
		sum.re[0],
		sum.im[0],
		cx,
		sum.re[1],
		sum.im[1],
		cy,
		sum.re[2],
		sum.im[2],
		1,
	]);
	if (!toPlane) return null;

	const rectify = (pts: readonly Pt[]) => pts.map((p) => apply(toPlane, p));
	let sideSum = 0;
	let sideCount = 0;
	for (const square of squares) {
		const r = rectify(square);
		if (r.some((p) => p === null)) continue;
		const q = r as Pt[];
		for (let k = 0; k < 4; k++) sideSum += length(q[k], q[(k + 1) % 4]);
		sideCount += 4;
	}
	const corners = rectify(quad);
	if (sideCount === 0 || corners.some((p) => p === null)) return null;
	const [tl, tr, br, bl] = corners as Pt[];
	const mmPerUnit = sideMm / (sideSum / sideCount);
	const widthMm = ((length(tl, tr) + length(bl, br)) / 2) * mmPerUnit;
	const heightMm = ((length(tl, bl) + length(tr, br)) / 2) * mmPerUnit;
	if (!(widthMm > 0 && heightMm > 0 && Number.isFinite(widthMm + heightMm))) return null;
	return { widthMm, heightMm };
}
