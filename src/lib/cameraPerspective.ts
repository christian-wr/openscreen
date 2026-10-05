import type { CameraPerspective } from "@/components/video-editor/types";

type Corners = CameraPerspective["corners"];

/** True when the quad is strictly convex: every turn has the same non-zero direction. */
function isConvexClockwiseOrCounter(c: Corners): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = c[i];
		const b = c[(i + 1) % 4];
		const d = c[(i + 2) % 4];
		const z = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
		if (!Number.isFinite(z) || Math.abs(z) <= 1e-9) return false;
		const s = z > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/**
 * Homography (row-major 3x3) mapping the unit square (0,0),(1,0),(1,1),(0,1) onto the four
 * points, in that order (Heckbert's closed form). Maps (u,v,1) in the target picture to the
 * point in the source camera image. Null for a degenerate or non-convex quad.
 */
export function homographyFromUnitSquare(c: Corners): number[] | null {
	if (!isConvexClockwiseOrCounter(c)) return null;
	const [p0, p1, p2, p3] = c;
	const dx1 = p1.x - p2.x;
	const dx2 = p3.x - p2.x;
	const dx3 = p0.x - p1.x + p2.x - p3.x;
	const dy1 = p1.y - p2.y;
	const dy2 = p3.y - p2.y;
	const dy3 = p0.y - p1.y + p2.y - p3.y;
	let g = 0;
	let h = 0;
	if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
		const den = dx1 * dy2 - dx2 * dy1;
		if (Math.abs(den) < 1e-12) return null;
		g = (dx3 * dy2 - dx2 * dy3) / den;
		h = (dx1 * dy3 - dx3 * dy1) / den;
	}
	const a = p1.x - p0.x + g * p1.x;
	const b = p3.x - p0.x + h * p3.x;
	const d = p1.y - p0.y + g * p1.y;
	const e = p3.y - p0.y + h * p3.y;
	return [a, b, p0.x, d, e, p0.y, g, h, 1];
}

/**
 * The homography with the margin folded in: the output's local [0,1]^2 maps to
 * [-m, 1+m]^2 of the quad, so the picture shows a border around the marked subject.
 * `aspect` is not part of the matrix; it sets the layer's box ratio.
 */
export function perspectiveMatrix(p: CameraPerspective): number[] | null {
	const h = homographyFromUnitSquare(p.corners);
	if (!h) return null;
	const m = p.margin ?? 0;
	const s = [1 + 2 * m, 0, -m, 0, 1 + 2 * m, -m, 0, 0, 1];
	const out: number[] = [];
	for (let r = 0; r < 3; r++) {
		for (let col = 0; col < 3; col++) {
			out.push(h[r * 3] * s[col] + h[r * 3 + 1] * s[3 + col] + h[r * 3 + 2] * s[6 + col]);
		}
	}
	return out;
}
