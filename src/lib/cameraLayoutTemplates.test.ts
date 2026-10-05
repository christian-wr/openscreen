import { describe, expect, it } from "vitest";
import { PIP_MARGIN_FRAC, PIP_WIDTH_FRAC, resolveCameraLayout } from "./cameraLayoutTemplates";

const ctx = {
	frame: { width: 1920, height: 1080 },
	cameraAspect: () => 16 / 9,
	pipShape: "rounded" as const,
	pipRadiusFrac: 0.12,
};
const region = (template: never, cameras: number[], rects: Record<number, unknown> = {}) =>
	({
		id: "r",
		startMs: 0,
		endMs: 5000,
		template,
		slots: cameras.map((camera, i) => ({ camera, ...(rects[i] ? { rect: rects[i] } : {}) })),
	}) as never;

describe("resolveCameraLayout", () => {
	it("camera-full fills the frame", () => {
		expect(resolveCameraLayout(region("camera-full" as never, [2]), ctx)).toEqual([
			{
				camera: 2,
				rect: { x: 0, y: 0, width: 1, height: 1 },
				radiusFrac: 0,
				shape: "rectangle",
				fillsFrame: true,
			},
		]);
	});
	it("side-by-side splits the frame in halves", () => {
		const layers = resolveCameraLayout(region("side-by-side" as never, [0, 1]), ctx);
		expect(layers.map((l) => l.rect)).toEqual([
			{ x: 0, y: 0, width: 0.5, height: 1 },
			{ x: 0.5, y: 0, width: 0.5, height: 1 },
		]);
	});
	it("screen-pip stacks pips from the bottom-right corner leftwards", () => {
		const [a, b] = resolveCameraLayout(region("screen-pip" as never, [0, 1]), ctx);
		expect(a.rect.x + a.rect.width).toBeCloseTo(1 - PIP_MARGIN_FRAC, 9);
		expect(a.rect.width).toBeCloseTo(PIP_WIDTH_FRAC, 9);
		expect(a.rect.height).toBeCloseTo(PIP_WIDTH_FRAC, 9); // 16:9 camera in a 16:9 frame
		expect(b.rect.x + b.rect.width).toBeLessThan(a.rect.x);
		expect([a.fillsFrame, b.fillsFrame]).toEqual([false, false]);
	});
	it("camera-full-pip draws the full camera first, then the pip", () => {
		const layers = resolveCameraLayout(region("camera-full-pip" as never, [1, 0]), ctx);
		expect(layers.map((l) => [l.camera, l.fillsFrame])).toEqual([
			[1, true],
			[0, false],
		]);
	});
	it("a user rect overrides the template position", () => {
		const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
		const [layer] = resolveCameraLayout(region("screen-pip" as never, [1], { 0: rect }), ctx);
		expect(layer.rect).toEqual(rect);
	});
	it("a portrait camera gets a taller pip box", () => {
		const [layer] = resolveCameraLayout(region("screen-pip" as never, [1]), {
			...ctx,
			cameraAspect: () => 9 / 16,
		});
		expect(layer.rect.height).toBeGreaterThan(layer.rect.width);
	});
	it("circle and square pips use a square box and the project's shape", () => {
		const [layer] = resolveCameraLayout(region("screen-pip" as never, [1]), {
			...ctx,
			pipShape: "circle",
			cameraAspect: () => 4 / 3,
		});
		expect(layer.shape).toBe("circle");
		expect(layer.rect.width * 1920).toBeCloseTo(layer.rect.height * 1080, 9);
	});
	it("a user rect on a full layer keeps its fillsFrame flag", () => {
		const rect = { x: 0, y: 0, width: 0.6, height: 1 };
		const [layer] = resolveCameraLayout(region("camera-full" as never, [1], { 0: rect }), ctx);
		expect(layer).toMatchObject({ rect, fillsFrame: true, shape: "rectangle" });
	});
});
