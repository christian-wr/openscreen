import type { CameraLayoutRegion, NormalizedRect } from "@/components/video-editor/types";

export interface ResolvedCameraLayer {
	camera: number;
	/** Output-frame fractions. */
	rect: NormalizedRect;
	/** Corner radius as a fraction of min(rect width, height) in pixels. */
	radiusFrac: number;
	/** Same vocabulary as `SceneLayout.webcamShape` (what the compositor's `webcam_shape_code` reads). */
	shape: "rectangle" | "rounded" | "circle" | "square";
	/** Covers the screen: drawn without a shadow. */
	fillsFrame: boolean;
}

export interface CameraLayoutContext {
	/** Output pixels. */
	frame: { width: number; height: number };
	/** Width/height of that camera's box (the perspective aspect when one is set). */
	cameraAspect: (camera: number) => number;
	/** The project's webcam shape. */
	pipShape: ResolvedCameraLayer["shape"];
	/** The project's webcam radius fraction. */
	pipRadiusFrac: number;
}

export const PIP_WIDTH_FRAC = 0.22;
export const PIP_MARGIN_FRAC = 0.025;
export const PIP_GAP_FRAC = 0.02;

const FULL_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const LEFT_HALF: NormalizedRect = { x: 0, y: 0, width: 0.5, height: 1 };
const RIGHT_HALF: NormalizedRect = { x: 0.5, y: 0, width: 0.5, height: 1 };

function fullLayer(camera: number, rect: NormalizedRect): ResolvedCameraLayer {
	return { camera, rect, radiusFrac: 0, shape: "rectangle", fillsFrame: true };
}

function pipLayer(camera: number, index: number, ctx: CameraLayoutContext): ResolvedCameraLayer {
	const { width, height } = ctx.frame;
	const w = PIP_WIDTH_FRAC;
	const squareBox = ctx.pipShape === "circle" || ctx.pipShape === "square";
	const cameraAspect = ctx.cameraAspect(camera);
	const safeAspect = Number.isFinite(cameraAspect) && cameraAspect > 0 ? cameraAspect : 16 / 9;
	const aspect = squareBox ? 1 : safeAspect;
	const h = (w * width) / aspect / height;
	const right = 1 - PIP_MARGIN_FRAC - index * (w + PIP_GAP_FRAC);
	const bottom = 1 - (PIP_MARGIN_FRAC * width) / height;
	return {
		camera,
		rect: { x: right - w, y: bottom - h, width: w, height: h },
		radiusFrac: ctx.pipRadiusFrac,
		shape: ctx.pipShape,
		fillsFrame: false,
	};
}

/**
 * Turns a layout region into positioned camera layers in draw order: frame-filling layers
 * first, then the PiPs, each in slot order. A slot's own `rect` overrides the template's
 * position but keeps its flags.
 */
export function resolveCameraLayout(
	region: CameraLayoutRegion,
	ctx: CameraLayoutContext,
): ResolvedCameraLayer[] {
	const full: ResolvedCameraLayer[] = [];
	const pips: ResolvedCameraLayer[] = [];
	region.slots.forEach((slot, i) => {
		let layer: ResolvedCameraLayer;
		if (region.template === "camera-full" || (region.template === "camera-full-pip" && i === 0)) {
			layer = fullLayer(slot.camera, { ...FULL_RECT });
		} else if (region.template === "side-by-side") {
			layer = fullLayer(slot.camera, { ...(i === 0 ? LEFT_HALF : RIGHT_HALF) });
		} else {
			const pipIndex = region.template === "camera-full-pip" ? i - 1 : i;
			layer = pipLayer(slot.camera, pipIndex, ctx);
		}
		if (slot.rect) layer = { ...layer, rect: { ...slot.rect } };
		(layer.fillsFrame ? full : pips).push(layer);
	});
	return [...full, ...pips];
}
