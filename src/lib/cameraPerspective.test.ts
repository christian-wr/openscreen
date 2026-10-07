import { describe, expect, it } from "vitest";
import { homographyFromUnitSquare, perspectiveMatrix } from "./cameraPerspective";

const apply = (h: number[], u: number, v: number) => {
	const w = h[6] * u + h[7] * v + h[8];
	return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
};
const quad = [
	{ x: 0.2, y: 0.3 },
	{ x: 0.85, y: 0.25 },
	{ x: 0.95, y: 0.9 },
	{ x: 0.1, y: 0.8 },
] as const;

describe("homographyFromUnitSquare", () => {
	it("maps the unit square's corners onto the four points", () => {
		const h = homographyFromUnitSquare([...quad] as never);
		expect(h).not.toBeNull();
		const corners = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		];
		corners.forEach(([u, v], i) => {
			const [x, y] = apply(h as number[], u, v);
			expect(x).toBeCloseTo(quad[i].x, 9);
			expect(y).toBeCloseTo(quad[i].y, 9);
		});
	});
	it("is the identity for the full image", () => {
		const h = homographyFromUnitSquare([
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 1, y: 1 },
			{ x: 0, y: 1 },
		]);
		expect(h?.map((n) => Number(n.toFixed(12)))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
	});
	it("rejects collinear and crossed quads", () => {
		expect(
			homographyFromUnitSquare([
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0 },
				{ x: 1, y: 0 },
				{ x: 0, y: 1 },
			]),
		).toBeNull();
		// bow-tie: top-right and bottom-right swapped
		expect(
			homographyFromUnitSquare([
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: 1, y: 0 },
				{ x: 0, y: 1 },
			]),
		).toBeNull();
	});
});

describe("perspectiveMatrix", () => {
	it("folds the margin in: the target edge lands outside the quad", () => {
		const h = perspectiveMatrix({ corners: [...quad] as never, aspect: 297 / 210, margin: 0.1 });
		const inner = perspectiveMatrix({ corners: [...quad] as never, aspect: 297 / 210 });
		expect(h).not.toBeNull();
		// the target point that maps to the quad's top-left corner moves inward by the margin
		const [x, y] = apply(h as number[], 0.1 / 1.2, 0.1 / 1.2);
		expect(x).toBeCloseTo(quad[0].x, 9);
		expect(y).toBeCloseTo(quad[0].y, 9);
		expect(apply(inner as number[], 0, 0)[0]).toBeCloseTo(quad[0].x, 9);
	});
	it("returns null for a degenerate quad", () => {
		expect(
			perspectiveMatrix({
				corners: [
					{ x: 0, y: 0 },
					{ x: 0.5, y: 0 },
					{ x: 1, y: 0 },
					{ x: 0, y: 1 },
				],
				aspect: 1.5,
			}),
		).toBeNull();
	});
});
