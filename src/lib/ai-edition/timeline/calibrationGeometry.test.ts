import { describe, expect, it } from "vitest";
import {
	type Corners,
	clampCrop,
	isFullCrop,
	isValidQuad,
	loupeSourceRect,
	nearestHandle,
	previewSize,
	renderRectified,
	resizeCrop,
} from "./calibrationGeometry";

describe("calibrationGeometry", () => {
	it("hit-tests the nearest handle within the radius", () => {
		const points = [
			{ x: 10, y: 10 },
			{ x: 100, y: 10 },
			{ x: 100, y: 100 },
			{ x: 10, y: 100 },
		];
		expect(nearestHandle(points, { x: 95, y: 14 }, 12)).toBe(1);
		expect(nearestHandle(points, { x: 14, y: 96 }, 12)).toBe(3);
		expect(nearestHandle(points, { x: 55, y: 55 }, 12)).toBeNull();
		// Two in reach: the closer one wins.
		expect(
			nearestHandle(
				[
					{ x: 0, y: 0 },
					{ x: 6, y: 0 },
				],
				{ x: 4, y: 0 },
				12,
			),
		).toBe(1);
	});

	it("the loupe rect stays inside the image", () => {
		expect(loupeSourceRect({ x: 2, y: 3 }, 640, 360, 120, 4)).toEqual({
			x: 0,
			y: 0,
			width: 30,
			height: 30,
		});
		expect(loupeSourceRect({ x: 639, y: 359 }, 640, 360, 120, 4)).toEqual({
			x: 610,
			y: 330,
			width: 30,
			height: 30,
		});
		expect(loupeSourceRect({ x: 320, y: 180 }, 640, 360, 120, 4)).toEqual({
			x: 305,
			y: 165,
			width: 30,
			height: 30,
		});
		// An image smaller than the loupe's area is shown whole.
		expect(loupeSourceRect({ x: 5, y: 5 }, 20, 10, 120, 4)).toEqual({
			x: 0,
			y: 0,
			width: 20,
			height: 10,
		});
	});

	it("a crossed quad is invalid", () => {
		const square: Corners = [
			{ x: 0.1, y: 0.1 },
			{ x: 0.9, y: 0.1 },
			{ x: 0.9, y: 0.9 },
			{ x: 0.1, y: 0.9 },
		];
		expect(isValidQuad(square)).toBe(true);
		const crossed: Corners = [square[0], square[2], square[1], square[3]];
		expect(isValidQuad(crossed)).toBe(false);
		const collinear: Corners = [
			{ x: 0.1, y: 0.1 },
			{ x: 0.5, y: 0.1 },
			{ x: 0.9, y: 0.1 },
			{ x: 0.1, y: 0.9 },
		];
		expect(isValidQuad(collinear)).toBe(false);
	});

	it("the rectified preview maps the quad corners to the canvas corners", () => {
		// A 100x100 grey image with a coloured 4x4 block at each corner of a skewed quad.
		const size = 100;
		const data = new Uint8ClampedArray(size * size * 4).fill(128);
		const colours = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 0],
		];
		const cornersPx = [
			{ x: 20, y: 10 },
			{ x: 80, y: 20 },
			{ x: 90, y: 85 },
			{ x: 10, y: 75 },
		];
		// Each block extends from the corner into the quad, so the corner pixel of the output
		// (sampled half a pixel inside) lands in it.
		const inward = [
			[1, 1],
			[-1, 1],
			[-1, -1],
			[1, -1],
		];
		cornersPx.forEach((c, k) => {
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 4; dx++) {
					const x = c.x + inward[k][0] * dx - (inward[k][0] < 0 ? 1 : 0);
					const y = c.y + inward[k][1] * dy - (inward[k][1] < 0 ? 1 : 0);
					const o = (y * size + x) * 4;
					data[o] = colours[k][0];
					data[o + 1] = colours[k][1];
					data[o + 2] = colours[k][2];
				}
			}
		});
		const corners = cornersPx.map((c) => ({ x: c.x / size, y: c.y / size })) as Corners;
		const { width, height } = previewSize(1, 40);
		const out = renderRectified(
			{ width: size, height: size, data },
			{ corners, aspect: 1 },
			width,
			height,
		);
		expect(out).not.toBeNull();
		const at = (i: number, j: number) => {
			const o = (j * width + i) * 4;
			return [out?.[o], out?.[o + 1], out?.[o + 2]];
		};
		expect(at(0, 0)).toEqual(colours[0]);
		expect(at(width - 1, 0)).toEqual(colours[1]);
		expect(at(width - 1, height - 1)).toEqual(colours[2]);
		expect(at(0, height - 1)).toEqual(colours[3]);
		// The middle is the grey of the sheet.
		expect(at(20, 20)).toEqual([128, 128, 128]);
	});

	it("keeps a crop inside the image and recognises the full frame", () => {
		expect(clampCrop({ x: 0.9, y: -0.2, width: 0.5, height: 0.01 })).toEqual({
			x: 0.5,
			y: 0,
			width: 0.5,
			height: 0.04,
		});
		const r = resizeCrop({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, { left: true }, -0.5, 0);
		expect(r).toEqual({ x: 0, y: 0.2, width: 0.7, height: 0.5 });
		expect(isFullCrop({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
		expect(isFullCrop(r)).toBe(false);
	});
});
