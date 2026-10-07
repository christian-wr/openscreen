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
	/**
	 * The clip's default camera-1 PiP (output-frame fractions), where the project places it.
	 * The first PiP takes its width and its right/bottom edges; further PiPs stack leftwards
	 * at the same width. Without it the PiPs sit in the bottom-right corner at `PIP_WIDTH_FRAC`.
	 */
	defaultPipRect?: NormalizedRect | null;
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

function usableRect(rect: NormalizedRect | null | undefined): NormalizedRect | null {
	if (!rect) return null;
	const values = [rect.x, rect.y, rect.width, rect.height];
	return values.every(Number.isFinite) && rect.width > 0 && rect.height > 0 ? rect : null;
}

function pipLayer(camera: number, index: number, ctx: CameraLayoutContext): ResolvedCameraLayer {
	const { width, height } = ctx.frame;
	const anchor = usableRect(ctx.defaultPipRect);
	const w = anchor ? anchor.width : PIP_WIDTH_FRAC;
	const squareBox = ctx.pipShape === "circle" || ctx.pipShape === "square";
	const cameraAspect = ctx.cameraAspect(camera);
	const safeAspect = Number.isFinite(cameraAspect) && cameraAspect > 0 ? cameraAspect : 16 / 9;
	const aspect = squareBox ? 1 : safeAspect;
	const h = (w * width) / aspect / height;
	const firstRight = anchor ? anchor.x + anchor.width : 1 - PIP_MARGIN_FRAC;
	const right = firstRight - index * (w + PIP_GAP_FRAC);
	const bottom = anchor ? anchor.y + anchor.height : 1 - (PIP_MARGIN_FRAC * width) / height;
	return {
		camera,
		rect: { x: right - w, y: bottom - h, width: w, height: h },
		radiusFrac: ctx.pipRadiusFrac,
		shape: ctx.pipShape,
		fillsFrame: false,
	};
}

/** Whether a template's place `index` covers the frame (or half of it) rather than being a PiP. */
export function slotFillsFrame(template: CameraLayoutRegion["template"], index: number): boolean {
	return (
		template === "camera-full" ||
		template === "side-by-side" ||
		(template === "camera-full-pip" && index === 0)
	);
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
		if (region.template === "side-by-side") {
			layer = fullLayer(slot.camera, { ...(i === 0 ? LEFT_HALF : RIGHT_HALF) });
		} else if (slotFillsFrame(region.template, i)) {
			layer = fullLayer(slot.camera, { ...FULL_RECT });
		} else {
			const pipIndex = region.template === "camera-full-pip" ? i - 1 : i;
			layer = pipLayer(slot.camera, pipIndex, ctx);
		}
		if (slot.rect) layer = { ...layer, rect: { ...slot.rect } };
		(layer.fillsFrame ? full : pips).push(layer);
	});
	return [...full, ...pips];
}
