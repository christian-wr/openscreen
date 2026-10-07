import { describe, expect, it } from "vitest";
import {
	PIP_GAP_FRAC,
	PIP_MARGIN_FRAC,
	PIP_WIDTH_FRAC,
	resolveCameraLayout,
} from "./cameraLayoutTemplates";

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
	it("the first pip takes the project's default pip rect, the next stacks left of it", () => {
		// A 16:9 camera's default PiP, 0.3 wide, in the top-left corner of a 16:9 frame.
		const defaultPipRect = { x: 0.05, y: 0.06, width: 0.3, height: 0.3 };
		const [a, b] = resolveCameraLayout(region("screen-pip" as never, [0, 1]), {
			...ctx,
			defaultPipRect,
		});
		for (const key of ["x", "y", "width", "height"] as const) {
			expect(a.rect[key]).toBeCloseTo(defaultPipRect[key], 9);
		}
		expect(b.rect.width).toBeCloseTo(0.3, 9);
		expect(b.rect.x + b.rect.width).toBeCloseTo(a.rect.x - PIP_GAP_FRAC, 9);
		expect(b.rect.y + b.rect.height).toBeCloseTo(a.rect.y + a.rect.height, 9);
		// A portrait camera keeps the width and bottom edge, with its own height.
		const [p] = resolveCameraLayout(region("screen-pip" as never, [1]), {
			...ctx,
			cameraAspect: () => 9 / 16,
			defaultPipRect,
		});
		expect(p.rect.width).toBeCloseTo(0.3, 9);
		expect(p.rect.y + p.rect.height).toBeCloseTo(0.36, 9);
		expect((p.rect.width * 1920) / (p.rect.height * 1080)).toBeCloseTo(9 / 16, 6);
	});
	it("without a usable default pip rect the corner constants stay", () => {
		const plain = resolveCameraLayout(region("screen-pip" as never, [0, 1]), ctx);
		for (const defaultPipRect of [null, { x: 0, y: 0, width: 0, height: 0.2 }]) {
			expect(
				resolveCameraLayout(region("screen-pip" as never, [0, 1]), { ...ctx, defaultPipRect }),
			).toEqual(plain);
		}
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
	it("returns copies of the template rects", () => {
		const [layer] = resolveCameraLayout(region("camera-full" as never, [1]), ctx);
		layer.rect.width = 0.1;
		const [again] = resolveCameraLayout(region("camera-full" as never, [1]), ctx);
		expect(again.rect.width).toBe(1);
		const [left] = resolveCameraLayout(region("side-by-side" as never, [0, 1]), ctx);
		left.rect.width = 0.1;
		expect(resolveCameraLayout(region("side-by-side" as never, [0, 1]), ctx)[0].rect.width).toBe(
			0.5,
		);
	});
	it("treats a non-finite or non-positive camera aspect as 16/9", () => {
		const [ref] = resolveCameraLayout(region("screen-pip" as never, [1]), ctx);
		for (const bad of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
			const [layer] = resolveCameraLayout(region("screen-pip" as never, [1]), {
				...ctx,
				cameraAspect: () => bad,
			});
			expect(layer.rect).toEqual(ref.rect);
		}
	});
});
