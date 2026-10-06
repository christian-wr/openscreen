import { describe, expect, it } from "vitest";
import { detectCornerMarkers, detectMarkedArea, markerBits, type RgbaImage } from "./arucoMarkers";

// A plain rasterizer: a white sheet with markers drawn from the dictionary bits, seen through a
// homography (sheet units → image pixels). Every image pixel is mapped back onto the sheet and
// sampled 4x4 times, so edges are anti-aliased like a camera's.

type Mat3 = number[];
interface Pt {
	x: number;
	y: number;
}

/** The homography taking the unit square's corners (0,0),(1,0),(1,1),(0,1) to `q`. */
function squareToQuad(q: [Pt, Pt, Pt, Pt]): Mat3 {
	const [p0, p1, p2, p3] = q;
	const dx1 = p1.x - p2.x;
	const dx2 = p3.x - p2.x;
	const dx3 = p0.x - p1.x + p2.x - p3.x;
	const dy1 = p1.y - p2.y;
	const dy2 = p3.y - p2.y;
	const dy3 = p0.y - p1.y + p2.y - p3.y;
	const den = dx1 * dy2 - dx2 * dy1;
	const g = (dx3 * dy2 - dx2 * dy3) / den;
	const h = (dx1 * dy3 - dx3 * dy1) / den;
	return [
		p1.x - p0.x + g * p1.x,
		p3.x - p0.x + h * p3.x,
		p0.x,
		p1.y - p0.y + g * p1.y,
		p3.y - p0.y + h * p3.y,
		p0.y,
		g,
		h,
		1,
	];
}

function apply(m: Mat3, p: Pt): Pt {
	const w = m[6] * p.x + m[7] * p.y + m[8];
	return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

function invert(m: Mat3): Mat3 {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		A / det,
		-(b * i - c * h) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		-(a * f - c * d) / det,
		C / det,
		-(a * h - b * g) / det,
		(a * e - b * d) / det,
	];
}

const SHEET_W = 200;
const SHEET_H = 150;
const MARKER = 36; // sheet units per marker side (6 cells of 6)
const INSET = 10;

/** Each marker's top-left on the sheet: one per sheet corner. */
const MARKER_ORIGINS: Record<number, Pt> = {
	0: { x: INSET, y: INSET },
	1: { x: SHEET_W - INSET - MARKER, y: INSET },
	2: { x: SHEET_W - INSET - MARKER, y: SHEET_H - INSET - MARKER },
	3: { x: INSET, y: SHEET_H - INSET - MARKER },
};

/** The marker corner facing the sheet's middle, in sheet units. */
const INNER_ON_SHEET: Pt[] = [
	{ x: INSET + MARKER, y: INSET + MARKER },
	{ x: SHEET_W - INSET - MARKER, y: INSET + MARKER },
	{ x: SHEET_W - INSET - MARKER, y: SHEET_H - INSET - MARKER },
	{ x: INSET + MARKER, y: SHEET_H - INSET - MARKER },
];

/** 0 (black) or 1 (white) at a sheet point. */
function sheetValue(p: Pt, ids: number[], bits: Map<number, boolean[][]>): number {
	for (const id of ids) {
		const o = MARKER_ORIGINS[id];
		const u = (p.x - o.x) / (MARKER / 6);
		const v = (p.y - o.y) / (MARKER / 6);
		if (u < 0 || v < 0 || u >= 6 || v >= 6) continue;
		const cx = Math.floor(u);
		const cy = Math.floor(v);
		if (cx === 0 || cy === 0 || cx === 5 || cy === 5) return 0; // black border
		return bits.get(id)?.[cy - 1][cx - 1] ? 1 : 0;
	}
	return 1;
}

/** The sheet (with markers `ids`) photographed so its corners land on `sheetCorners` (px). */
function photograph(
	width: number,
	height: number,
	sheetCorners: [Pt, Pt, Pt, Pt],
	ids: number[],
): { image: RgbaImage; toImage: (p: Pt) => Pt } {
	const unitToImage = squareToQuad(sheetCorners);
	const toImage = (p: Pt) => apply(unitToImage, { x: p.x / SHEET_W, y: p.y / SHEET_H });
	const imageToUnit = invert(unitToImage);
	const bits = new Map(ids.map((id) => [id, markerBits(id)]));
	const data = new Uint8ClampedArray(width * height * 4);
	const SS = 4;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let inside = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const u = apply(imageToUnit, { x: x + (sx + 0.5) / SS, y: y + (sy + 0.5) / SS });
					if (u.x < 0 || u.y < 0 || u.x > 1 || u.y > 1) continue;
					inside++;
					sum += sheetValue({ x: u.x * SHEET_W, y: u.y * SHEET_H }, ids, bits);
				}
			}
			// The desk around the sheet is a mid grey; paper white is 235, ink 20.
			const n = SS * SS;
			const value = ((n - inside) * 110 + sum * 235 + (inside - sum) * 20) / n;
			const i = (y * width + x) * 4;
			data[i] = value;
			data[i + 1] = value;
			data[i + 2] = value;
			data[i + 3] = 255;
		}
	}
	return { image: { width, height, data }, toImage };
}

const W = 640;
const H = 480;
/** A slight perspective: the far edge narrower, a little tilt. */
const TILTED: [Pt, Pt, Pt, Pt] = [
	{ x: 120, y: 70 },
	{ x: 530, y: 85 },
	{ x: 590, y: 420 },
	{ x: 60, y: 400 },
];

function expectNear(actual: Pt, expected: Pt, tolPx: number) {
	expect(Math.abs(actual.x * W - expected.x)).toBeLessThanOrEqual(tolPx);
	expect(Math.abs(actual.y * H - expected.y)).toBeLessThanOrEqual(tolPx);
}

describe("detectCornerMarkers", () => {
	it("detects four markers and orders the inner corners", () => {
		const { image, toImage } = photograph(W, H, TILTED, [0, 1, 2, 3]);
		const corners = detectCornerMarkers(image);
		expect(corners).not.toBeNull();
		corners?.forEach((c, i) => {
			expectNear(c, toImage(INNER_ON_SHEET[i]), 1.5);
		});
	});

	it("fewer than four markers leaves the corners unchanged", () => {
		const { image } = photograph(W, H, TILTED, [0, 1, 3]);
		expect(detectCornerMarkers(image)).toBeNull();
	});

	it("a rotated sheet still maps id 0 to top-left", () => {
		// The sheet turned a quarter clockwise: its top-left corner now lies top-right.
		const rotated: [Pt, Pt, Pt, Pt] = [
			{ x: 520, y: 40 },
			{ x: 540, y: 440 },
			{ x: 230, y: 430 },
			{ x: 220, y: 60 },
		];
		const { image, toImage } = photograph(W, H, rotated, [0, 1, 2, 3]);
		const corners = detectCornerMarkers(image);
		expect(corners).not.toBeNull();
		corners?.forEach((c, i) => {
			expectNear(c, toImage(INNER_ON_SHEET[i]), 1.5);
		});
		// Marker 0 sits on the right of the picture now, and is still returned first.
		expect(corners?.[0].x).toBeGreaterThan(0.5);
	});

	it("an empty picture finds nothing", () => {
		const { image } = photograph(W, H, TILTED, []);
		expect(detectCornerMarkers(image)).toBeNull();
	});
});

// The marked rectangle on the test sheet: between the inner corners, in sheet units.
const AREA_W = SHEET_W - 2 * (INSET + MARKER);
const AREA_H = SHEET_H - 2 * (INSET + MARKER);
/** A sheet unit in millimetres: the printed marker is 40 mm. */
const MM_PER_UNIT = 40 / MARKER;

function expectWithin(actual: number, expected: number, fraction: number) {
	expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(fraction);
}

describe("detectMarkedArea", () => {
	it("measures the marked rectangle's real size through the perspective", () => {
		const area = detectMarkedArea(photograph(W, H, TILTED, [0, 1, 2, 3]).image);
		expect(area?.size).toBeTruthy();
		expectWithin(area?.size?.widthMm ?? 0, AREA_W * MM_PER_UNIT, 0.03);
		expectWithin(area?.size?.heightMm ?? 0, AREA_H * MM_PER_UNIT, 0.03);
	});

	it("measures under a steep keystone, where the picture's own proportions are far off", () => {
		// The far edge at half the width of the near one, like a desk camera on an arm.
		const steep: [Pt, Pt, Pt, Pt] = [
			{ x: 190, y: 90 },
			{ x: 450, y: 90 },
			{ x: 620, y: 440 },
			{ x: 20, y: 440 },
		];
		const area = detectMarkedArea(photograph(W, H, steep, [0, 1, 2, 3]).image);
		const aspect = (area?.size?.widthMm ?? 0) / (area?.size?.heightMm ?? 1);
		expectWithin(aspect, AREA_W / AREA_H, 0.04);
	});

	it("measures a rotated sheet in its own orientation", () => {
		const rotated: [Pt, Pt, Pt, Pt] = [
			{ x: 520, y: 40 },
			{ x: 540, y: 440 },
			{ x: 230, y: 430 },
			{ x: 220, y: 60 },
		];
		const area = detectMarkedArea(photograph(W, H, rotated, [0, 1, 2, 3]).image);
		expectWithin(area?.size?.widthMm ?? 0, AREA_W * MM_PER_UNIT, 0.03);
		expectWithin(area?.size?.heightMm ?? 0, AREA_H * MM_PER_UNIT, 0.03);
	});

	it("returns the same corners as detectCornerMarkers", () => {
		const { image } = photograph(W, H, TILTED, [0, 1, 2, 3]);
		expect(detectMarkedArea(image)?.corners).toEqual(detectCornerMarkers(image));
	});

	it("finds nothing without all four markers", () => {
		expect(detectMarkedArea(photograph(W, H, TILTED, [0, 1, 3]).image)).toBeNull();
	});
});
