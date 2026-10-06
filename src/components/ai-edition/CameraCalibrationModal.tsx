// The camera calibration dialog. Perspective mode: four corner handles on a still of the camera,
// dragged with the pointer or nudged with the arrow keys, a loupe for the corner being placed,
// the target format and margin, and a live preview of the corrected picture. "Detect markers"
// finds the four printed markers (`arucoMarkers.ts`); when they fix the desk plane the frame
// shows the straightened desk with a crop on it (`planeCrop.ts`), otherwise the corners go onto
// the markers. "Print marker sheet" prints them (`markerSheet.ts`). Crop mode: a rectangle with
// corner and edge handles. Built on `ModalShell`, so the editor's shortcuts and undo stay blocked while it is open; Apply hands
// back one settings patch (one undo step).

import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	CameraPerspective,
	CameraPoint,
	CameraSettings,
	CropRegion,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type Corners,
	type CropEdges,
	clampCrop,
	clampPoint,
	insetCorners,
	isFullCrop,
	isValidQuad,
	loupeSourceRect,
	moveCrop,
	nearestHandle,
	previewSize,
	renderRectified,
	resizeCrop,
} from "@/lib/ai-edition/timeline/calibrationGeometry";
import { grabFrame } from "@/lib/ai-edition/timeline/grabFrame";
import {
	type CropCorner,
	cropAspectOf,
	cropLeavesImage,
	cropToPerspective,
	fitCrop,
	fitCropInside,
	perspectiveToCrop,
	planeView,
	resizeCropLocked,
} from "@/lib/ai-edition/timeline/planeCrop";
import { detectMarkedArea } from "@/lib/arucoMarkers";
import { printMarkerSheet } from "@/lib/markerSheet";
import type { CalibrationMode } from "./CamerasSection";
import { previewBoxStyle } from "./cropDraft";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";
import { ChoiceRow } from "./RightPanes";

/** The camera being calibrated and the still it is calibrated on. */
export interface CalibrationCamera {
	/** 0 = camera 1. */
	index: number;
	label: string;
	/** Video URL of the camera's file. */
	src: string;
	/** Time of that file shown by the playhead. */
	timeSec: number;
}

export interface CameraCalibrationModalProps {
	open: boolean;
	camera: CalibrationCamera;
	mode: CalibrationMode;
	/** The camera's stored settings; the dialog starts from them. */
	initial: CameraSettings | null;
	/** The camera has a crop, which a perspective replaces. Camera 1 keeps its crop outside
	 *  `initial`, so the caller says; defaults to `initial.crop`. */
	hasCrop?: boolean;
	/** The change to store (a key set to `undefined` removes it); called at most once. */
	onApply: (patch: Partial<CameraSettings>) => void;
	onClose: () => void;
}

type FormatId = "a4Portrait" | "a4Landscape" | "wide" | "standard" | "square" | "free";

const FORMATS: ReadonlyArray<{ id: FormatId; aspect: number | null }> = [
	{ id: "a4Portrait", aspect: 210 / 297 },
	{ id: "a4Landscape", aspect: 297 / 210 },
	{ id: "wide", aspect: 16 / 9 },
	{ id: "standard", aspect: 4 / 3 },
	{ id: "square", aspect: 1 },
	{ id: "free", aspect: null },
];

type PlaneFormatId = "standard" | "wide" | "tall" | "square" | "free";

/** Formats of a crop on the rectified desk. */
const PLANE_FORMATS: ReadonlyArray<{ id: PlaneFormatId; aspect: number | null }> = [
	{ id: "standard", aspect: 4 / 3 },
	{ id: "wide", aspect: 16 / 9 },
	{ id: "tall", aspect: 9 / 16 },
	{ id: "square", aspect: 1 },
	{ id: "free", aspect: null },
];

/** Long side of the rectified desk drawn in the big frame. */
const PLANE_VIEW_LONG_SIDE_PX = 960;

const MIN_ASPECT = 0.1;
const MAX_ASPECT = 10;
const MAX_MARGIN_PCT = 20;
/** How far from a corner (screen px) a press still grabs it. */
const HANDLE_RADIUS_PX = 24;
const LOUPE_SIZE_PX = 120;
const LOUPE_ZOOM = 4;
const PREVIEW_LONG_SIDE_PX = 320;
/** One arrow press in crop mode, as a fraction of the image. */
const CROP_STEP = 0.01;

/** What "Detect markers" last reported. */
type MarkerResult = { kind: "found" } | { kind: "noPlane" } | { kind: "notFound" };

const CORNER_KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
const CROP_CORNERS = ["nw", "ne", "sw", "se"] as const;
const CROP_EDGES = ["n", "s", "w", "e"] as const;
const FULL_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

function formatOf(aspect: number): FormatId {
	const match = FORMATS.find((f) => f.aspect !== null && Math.abs(f.aspect - aspect) < 1e-3);
	return match?.id ?? "free";
}

function planeFormatOf(aspect: number): PlaneFormatId {
	const match = PLANE_FORMATS.find((f) => f.aspect !== null && Math.abs(f.aspect - aspect) < 1e-3);
	return match?.id ?? "free";
}

function parseAspect(text: string): number | null {
	const value = Number(text.replace(",", "."));
	return Number.isFinite(value) && value >= MIN_ASPECT && value <= MAX_ASPECT ? value : null;
}

function copyCorners(c: Corners): Corners {
	return [{ ...c[0] }, { ...c[1] }, { ...c[2] }, { ...c[3] }];
}

/** A stored correction that can reopen as a crop on the desk: no margin, a usable quad. */
function storedPlane(stored: CameraPerspective | undefined): CameraPerspective | null {
	if (!stored || stored.margin) return null;
	const base = { corners: copyCorners(stored.corners), aspect: stored.aspect };
	return planeView(base) ? base : null;
}

/** The corner a pair of moved edges names; null for a single edge. */
function cornerOf(edges: CropEdges): CropCorner | null {
	const ns = edges.top ? "n" : edges.bottom ? "s" : null;
	const we = edges.left ? "w" : edges.right ? "e" : null;
	return ns && we ? (`${ns}${we}` as CropCorner) : null;
}

/**
 * A pointer drag on `window` until release or cancel; `onMove` gets the offset from the press.
 * Returns a disposer that removes the listeners early (the dialog closing mid-drag).
 */
function trackDrag(e: ReactPointerEvent, onMove: (dxPx: number, dyPx: number) => void) {
	const startX = e.clientX;
	const startY = e.clientY;
	const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY);
	const stop = () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
	return stop;
}

export function CameraCalibrationModal({
	open,
	camera,
	mode,
	initial,
	hasCrop = initial?.crop != null,
	onApply,
	onClose,
}: CameraCalibrationModalProps) {
	const t = useScopedT("dialogs");
	const tc = useScopedT("common");
	// The dialog is mounted per opening, so the stored settings seed the draft once.
	const stored = initial?.perspective;
	const [corners, setCorners] = useState<Corners>(() =>
		stored ? copyCorners(stored.corners) : insetCorners(),
	);
	const [format, setFormat] = useState<FormatId>(() =>
		stored ? formatOf(stored.aspect) : "a4Landscape",
	);
	const [freeAspect, setFreeAspect] = useState(() =>
		stored ? String(Math.round(stored.aspect * 1000) / 1000) : "1.5",
	);
	const [marginPct, setMarginPct] = useState(() => Math.round((stored?.margin ?? 0) * 100));
	const [crop, setCrop] = useState<CropRegion>(() => initial?.crop ?? FULL_CROP);
	const [image, setImage] = useState<ImageData | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [activeHandle, setActiveHandle] = useState<number | null>(null);
	const [markerResult, setMarkerResult] = useState<MarkerResult | null>(null);
	// The desk plane: a true rectangle on it (from the markers or the stored correction), the crop
	// the user places on its rectified view, and the plane's real width when the markers told it.
	const [plane, setPlane] = useState<CameraPerspective | null>(() => storedPlane(stored));
	const [manual, setManual] = useState(() => storedPlane(stored) === null);
	const [planeWidthMm, setPlaneWidthMm] = useState<number | null>(null);
	// The markers' inner corners, which the default crop stays inside; null for a stored plane.
	const [markerInner, setMarkerInner] = useState<Corners | null>(null);
	const [planeFormat, setPlaneFormat] = useState<PlaneFormatId>(() =>
		storedPlane(stored) ? planeFormatOf(stored?.aspect ?? 1) : "wide",
	);
	const view = useMemo(() => (plane ? planeView(plane) : null), [plane]);
	/** Where the plane's base rectangle sits in the view: the default crop's box. */
	const baseBox = useMemo(
		() => (view && plane ? perspectiveToCrop(view, plane) : null),
		[view, plane],
	);
	const [planeCrop, setPlaneCrop] = useState<CropRegion>(() => {
		const base = storedPlane(stored);
		const v = base ? planeView(base) : null;
		return (v && base && perspectiveToCrop(v, base)) ?? FULL_CROP;
	});

	const frameRef = useRef<HTMLDivElement | null>(null);
	const stillRef = useRef<HTMLCanvasElement | null>(null);
	const loupeRef = useRef<HTMLCanvasElement | null>(null);
	const previewRef = useRef<HTMLCanvasElement | null>(null);
	const planeRef = useRef<HTMLCanvasElement | null>(null);
	const handleRefs = useRef<Array<HTMLButtonElement | null>>([]);
	// The running drag's disposer: a new drag or unmounting ends the previous one.
	const stopDragRef = useRef<(() => void) | null>(null);

	useEffect(
		() => () => {
			stopDragRef.current?.();
			stopDragRef.current = null;
		},
		[],
	);

	// The marker message describes the corners as detected; any manual change makes it stale.
	const startDrag = (e: ReactPointerEvent, onMove: (dxPx: number, dyPx: number) => void) => {
		setMarkerResult(null);
		stopDragRef.current?.();
		stopDragRef.current = trackDrag(e, onMove);
	};

	// The still, at full resolution.
	useEffect(() => {
		let cancelled = false;
		setImage(null);
		setLoadFailed(false);
		grabFrame(camera.src, camera.timeSec)
			.then((data) => {
				if (!cancelled) setImage(data);
			})
			.catch(() => {
				if (!cancelled) setLoadFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [camera.src, camera.timeSec]);

	// Paint the still. No 2D context (jsdom) leaves the canvas blank; the handles still work.
	useEffect(() => {
		const canvas = stillRef.current;
		if (!canvas || !image) return;
		canvas.width = image.width;
		canvas.height = image.height;
		canvas.getContext("2d")?.putImageData(image, 0, 0);
	}, [image]);

	const aspect =
		format === "free"
			? parseAspect(freeAspect)
			: (FORMATS.find((f) => f.id === format)?.aspect ?? null);
	const margin = marginPct / 100;
	const quadValid = isValidQuad(corners);
	// Memoized: the preview resamples whenever this object changes, not on every render.
	const handPerspective = useMemo<CameraPerspective | null>(
		() =>
			quadValid && aspect !== null ? { corners, aspect, ...(margin > 0 ? { margin } : {}) } : null,
		[corners, aspect, margin, quadValid],
	);
	const planeMode = mode === "perspective" && !manual && view !== null;
	const planeAspect = PLANE_FORMATS.find((f) => f.id === planeFormat)?.aspect ?? null;
	const planePerspective = useMemo(
		() => (planeMode && view ? cropToPerspective(view, planeCrop) : null),
		[planeMode, view, planeCrop],
	);
	const planeAspectOk =
		planePerspective !== null &&
		planePerspective.aspect >= MIN_ASPECT &&
		planePerspective.aspect <= MAX_ASPECT;
	const perspective = planeMode ? (planeAspectOk ? planePerspective : null) : handPerspective;
	const preview = previewSize(perspective?.aspect ?? aspect ?? 1, PREVIEW_LONG_SIDE_PX);

	// The corrected picture, resampled on every change of the corners, format or margin.
	useEffect(() => {
		if (mode !== "perspective") return;
		const canvas = previewRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (!image || !perspective) return;
		const pixels = renderRectified(image, perspective, canvas.width, canvas.height);
		if (pixels) ctx.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
	}, [mode, image, perspective]);

	// The rectified desk under the crop, redrawn when the plane changes.
	useEffect(() => {
		const canvas = planeRef.current;
		const ctx = canvas?.getContext("2d");
		if (!planeMode || !canvas || !ctx || !image || !view) return;
		const size = previewSize(view.aspect, PLANE_VIEW_LONG_SIDE_PX);
		canvas.width = size.width;
		canvas.height = size.height;
		const pixels = renderRectified(image, view, size.width, size.height);
		if (pixels) ctx.putImageData(new ImageData(pixels, size.width, size.height), 0, 0);
	}, [planeMode, image, view]);

	// The loupe: the area under the active corner, magnified, crisp pixels and a crosshair.
	useEffect(() => {
		const canvas = loupeRef.current;
		const source = stillRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !source || !ctx || !image || activeHandle === null) return;
		const c = corners[activeHandle];
		const center = { x: c.x * image.width, y: c.y * image.height };
		const r = loupeSourceRect(center, image.width, image.height, LOUPE_SIZE_PX, LOUPE_ZOOM);
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, LOUPE_SIZE_PX, LOUPE_SIZE_PX);
		ctx.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, LOUPE_SIZE_PX, LOUPE_SIZE_PX);
		const cx = ((center.x - r.x) / r.width) * LOUPE_SIZE_PX;
		const cy = ((center.y - r.y) / r.height) * LOUPE_SIZE_PX;
		ctx.strokeStyle = "rgb(255 80 80)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(cx, 0);
		ctx.lineTo(cx, LOUPE_SIZE_PX);
		ctx.moveTo(0, cy);
		ctx.lineTo(LOUPE_SIZE_PX, cy);
		ctx.stroke();
	}, [image, corners, activeHandle]);

	const setCorner = (index: number, p: CameraPoint) => {
		setMarkerResult(null);
		setCorners((prev) => {
			const next = copyCorners(prev);
			next[index] = clampPoint(p);
			return next;
		});
	};

	// A press anywhere near a corner grabs it, so a corner is found without aiming at its dot.
	const onFramePointerDown = (e: ReactPointerEvent) => {
		const frame = frameRef.current;
		if (!frame) return;
		const r = frame.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		const points = corners.map((c) => ({ x: c.x * r.width, y: c.y * r.height }));
		const hit = nearestHandle(
			points,
			{ x: e.clientX - r.left, y: e.clientY - r.top },
			HANDLE_RADIUS_PX,
		);
		if (hit === null) return;
		e.preventDefault();
		handleRefs.current[hit]?.focus();
		setActiveHandle(hit);
		const start = corners[hit];
		startDrag(e, (dx, dy) =>
			setCorner(hit, { x: start.x + dx / r.width, y: start.y + dy / r.height }),
		);
	};

	// The arrows move the focused corner by one image pixel, ten with Shift.
	const onHandleKeyDown = (index: number) => (e: ReactKeyboardEvent) => {
		const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
		const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
		if (dx === 0 && dy === 0) return;
		// The editor shell seeks on the arrows, from window: keep them here.
		e.preventDefault();
		e.nativeEvent.stopPropagation();
		const step = e.shiftKey ? 10 : 1;
		const c = corners[index];
		setCorner(index, {
			x: c.x + (dx * step) / (image?.width ?? 1000),
			y: c.y + (dy * step) / (image?.height ?? 1000),
		});
	};

	// The rectangle the crop handles move: the camera crop, or the crop on the rectified desk.
	const activeCrop = planeMode ? planeCrop : crop;
	const setActiveCrop = planeMode ? setPlaneCrop : setCrop;
	/** Real aspect the crop must keep while resized; null = free. */
	const lockedAspect = planeMode ? planeAspect : null;

	const resizeActive = (start: CropRegion, edges: CropEdges, dx: number, dy: number) => {
		const corner = cornerOf(edges);
		return lockedAspect !== null && corner && view
			? resizeCropLocked(start, corner, dx, dy, view.aspect, lockedAspect)
			: resizeCrop(start, edges, dx, dy);
	};

	const startCropMove = (e: ReactPointerEvent) => {
		const frame = frameRef.current;
		if (!frame) return;
		e.preventDefault();
		e.stopPropagation();
		const r = frame.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		const start = activeCrop;
		startDrag(e, (dx, dy) => setActiveCrop(moveCrop(start, dx / r.width, dy / r.height)));
	};

	const startCropResize = (edges: CropEdges) => (e: ReactPointerEvent) => {
		const frame = frameRef.current;
		if (!frame) return;
		e.preventDefault();
		e.stopPropagation();
		const r = frame.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		const start = activeCrop;
		startDrag(e, (dx, dy) =>
			setActiveCrop(resizeActive(start, edges, dx / r.width, dy / r.height)),
		);
	};

	// The arrows move the crop; Shift + the arrows resize it from its bottom-right corner.
	const onCropKeyDown = (e: ReactKeyboardEvent) => {
		const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
		const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
		if (dx === 0 && dy === 0) return;
		e.preventDefault();
		e.nativeEvent.stopPropagation();
		if (e.shiftKey) {
			// A locked aspect resizes from the corner, so both arrows count.
			const edges =
				lockedAspect !== null
					? { right: true, bottom: true }
					: { right: dx !== 0, bottom: dy !== 0 };
			setActiveCrop(resizeActive(activeCrop, edges, dx * CROP_STEP, dy * CROP_STEP));
			return;
		}
		setActiveCrop(moveCrop(activeCrop, dx * CROP_STEP, dy * CROP_STEP));
	};

	// The format's largest crop, centred on the markers and inside them and the camera image; a
	// stored plane (no markers) fits it into the plane's rectangle.
	const defaultCrop = (
		v: CameraPerspective,
		target: number | null,
		box: CropRegion,
		inner: Corners | null,
	) => (inner ? fitCropInside(v, target, box, inner) : fitCrop(v.aspect, target, box));

	// The markers fix the desk plane; the crop on it starts as the format's largest rectangle
	// inside them. Without a plane they still place the four corners.
	const detectMarkers = () => {
		if (!image) return;
		const area = detectMarkedArea(image);
		if (!area) {
			setMarkerResult({ kind: "notFound" });
			return;
		}
		setCorners(copyCorners(area.corners));
		const base = area.plane
			? { corners: copyCorners(area.plane.corners), aspect: area.plane.aspect }
			: null;
		const nextView = base ? planeView(base) : null;
		const box = nextView && base ? perspectiveToCrop(nextView, base) : null;
		if (!base || !nextView || !box) {
			setManual(true);
			setMarkerResult({ kind: "noPlane" });
			return;
		}
		setPlane(base);
		setPlaneWidthMm(area.plane?.widthMm ?? null);
		setMarkerInner(copyCorners(area.corners));
		setPlaneCrop(defaultCrop(nextView, planeAspect, box, area.corners));
		setManual(false);
		setMarkerResult({ kind: "found" });
	};

	const selectPlaneFormat = (id: PlaneFormatId) => {
		setPlaneFormat(id);
		const target = PLANE_FORMATS.find((f) => f.id === id)?.aspect ?? null;
		if (target !== null && view && baseBox) {
			setPlaneCrop(defaultCrop(view, target, baseBox, markerInner));
		}
	};

	// Real size of the crop, when the markers measured the plane.
	const cropSizeCm =
		planeMode && view && baseBox && planeWidthMm !== null
			? (() => {
					const widthMm = (planeCrop.width / baseBox.width) * planeWidthMm;
					return {
						width: Math.round(widthMm / 10),
						height: Math.round(widthMm / cropAspectOf(view.aspect, planeCrop) / 10),
					};
				})()
			: null;

	const printSheet = () => {
		// Marker ID n belongs on corner n, the handles' order.
		const label = (id: number) => `${id} – ${t(`cameraCalibration.corners.${CORNER_KEYS[id]}`)}`;
		printMarkerSheet({
			instruction: t("cameraCalibration.markerSheetInstruction"),
			labels: [label(0), label(1), label(2), label(3)],
		});
	};

	const isPerspective = mode === "perspective";
	const canApply = isPerspective ? perspective !== null : true;
	const hasStored = isPerspective ? Boolean(initial?.perspective) : Boolean(initial?.crop);

	const apply = () => {
		if (isPerspective) {
			if (!perspective) return;
			onApply({ perspective: { ...perspective, corners: copyCorners(perspective.corners) } });
		} else {
			const next = clampCrop(crop);
			onApply({ crop: isFullCrop(next) ? undefined : next });
		}
		onClose();
	};

	// Reset removes the stored correction (or crop) altogether.
	const reset = () => {
		setMarkerResult(null);
		onApply(isPerspective ? { perspective: undefined } : { crop: undefined });
		onClose();
	};

	const imageAspect = image ? image.width / image.height : 16 / 9;
	const title = isPerspective
		? t("cameraCalibration.titlePerspective", { camera: camera.label })
		: t("cameraCalibration.titleCrop", { camera: camera.label });
	// The loupe sits in the corner away from the corner being placed.
	const active = activeHandle === null ? null : corners[activeHandle];
	const loupeOnRight = active !== null && active.x < 0.5 && active.y < 0.5;

	return (
		<ModalShell open={open} onClose={onClose} title={title} wide>
			<p className={styles.hint} style={{ margin: "0 0 10px" }}>
				{planeMode
					? t("cameraCalibration.planeHelp")
					: isPerspective
						? t("cameraCalibration.perspectiveHelp")
						: t("cameraCalibration.cropHelp")}
			</p>
			{isPerspective && hasCrop ? (
				<p className={styles.hint} style={{ margin: "0 0 10px" }}>
					{t("cameraCalibration.cropIgnored")}
				</p>
			) : null}
			<div
				ref={frameRef}
				data-testid="calibration-frame"
				style={{
					...previewBoxStyle(planeMode && view ? view.aspect : imageAspect),
					touchAction: "none",
				}}
				onPointerDown={isPerspective && !planeMode ? onFramePointerDown : undefined}
			>
				{/* Hidden on the desk, but still the loupe's source. */}
				<canvas
					ref={stillRef}
					aria-hidden
					style={{
						position: "absolute",
						inset: 0,
						width: "100%",
						height: "100%",
						display: planeMode ? "none" : undefined,
					}}
				/>
				{planeMode ? (
					<canvas
						ref={planeRef}
						data-testid="calibration-plane"
						aria-hidden
						style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
					/>
				) : null}
				{image === null ? (
					<p
						className={styles.hint}
						style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}
					>
						{loadFailed ? t("cameraCalibration.loadFailed") : t("cameraCalibration.loading")}
					</p>
				) : null}
				{isPerspective && !planeMode ? (
					<>
						<svg
							aria-hidden
							viewBox="0 0 1 1"
							preserveAspectRatio="none"
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
						>
							<polygon
								points={corners.map((c) => `${c.x},${c.y}`).join(" ")}
								fill={quadValid ? "rgb(80 160 255 / 0.15)" : "rgb(255 80 80 / 0.2)"}
								stroke={quadValid ? "rgb(255 255 255 / 0.9)" : "rgb(255 80 80)"}
								strokeWidth={1.5}
								vectorEffect="non-scaling-stroke"
							/>
						</svg>
						{corners.map((c, i) => (
							<button
								key={CORNER_KEYS[i]}
								ref={(el) => {
									handleRefs.current[i] = el;
								}}
								type="button"
								data-testid={`calibration-handle-${i}`}
								aria-label={t(`cameraCalibration.corners.${CORNER_KEYS[i]}`)}
								aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
								onFocus={() => setActiveHandle(i)}
								onBlur={() => setActiveHandle((a) => (a === i ? null : a))}
								onKeyDown={onHandleKeyDown(i)}
								style={{
									position: "absolute",
									left: `${c.x * 100}%`,
									top: `${c.y * 100}%`,
									width: 16,
									height: 16,
									padding: 0,
									transform: "translate(-50%, -50%)",
									borderRadius: "50%",
									border: "2px solid #fff",
									background: activeHandle === i ? "rgb(80 160 255)" : "rgb(0 0 0 / 0.5)",
									cursor: "move",
								}}
							/>
						))}
						{activeHandle !== null && image ? (
							<canvas
								ref={loupeRef}
								aria-label={t("cameraCalibration.loupe")}
								width={LOUPE_SIZE_PX}
								height={LOUPE_SIZE_PX}
								style={{
									position: "absolute",
									top: 8,
									...(loupeOnRight ? { right: 8 } : { left: 8 }),
									width: LOUPE_SIZE_PX,
									height: LOUPE_SIZE_PX,
									border: "2px solid #fff",
									borderRadius: 6,
									background: "#000",
									pointerEvents: "none",
								}}
							/>
						) : null}
					</>
				) : (
					<div
						className={styles.cropRegion}
						role="slider"
						data-testid="calibration-crop"
						aria-label={t("cameraCalibration.cropArea")}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(activeCrop.width * 100)}
						aria-valuetext={`${Math.round(activeCrop.x * 100)}%, ${Math.round(activeCrop.y * 100)}%, ${Math.round(activeCrop.width * 100)}% × ${Math.round(activeCrop.height * 100)}%`}
						aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
						tabIndex={0}
						onKeyDown={onCropKeyDown}
						onPointerDown={startCropMove}
						style={{
							position: "absolute",
							left: `${activeCrop.x * 100}%`,
							top: `${activeCrop.y * 100}%`,
							width: `${activeCrop.width * 100}%`,
							height: `${activeCrop.height * 100}%`,
							border: "1.5px solid rgb(255 255 255 / 0.9)",
							borderRadius: 4,
							boxShadow: "0 0 0 9999px var(--overlay-dark)",
							cursor: "move",
							touchAction: "none",
							...({ "--bracket": "22px", "--bracket-w": "4px" } as CSSProperties),
						}}
					>
						{CROP_CORNERS.map((corner) => (
							<span
								key={corner}
								className={styles.framingHandle}
								data-corner={corner}
								onPointerDown={startCropResize({
									top: corner.startsWith("n"),
									bottom: corner.startsWith("s"),
									left: corner.endsWith("w"),
									right: corner.endsWith("e"),
								})}
							/>
						))}
						{lockedAspect === null
							? CROP_EDGES.map((edge) => (
									<span
										key={edge}
										className={styles.cropEdge}
										data-edge={edge}
										onPointerDown={startCropResize({
											top: edge === "n",
											bottom: edge === "s",
											left: edge === "w",
											right: edge === "e",
										})}
									/>
								))
							: null}
					</div>
				)}
			</div>

			{isPerspective ? (
				<div
					style={{
						display: "flex",
						gap: 8,
						flexWrap: "wrap",
						alignItems: "center",
						margin: "10px 0",
					}}
				>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={detectMarkers}
						disabled={image === null}
					>
						{t("cameraCalibration.detectMarkers")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={printSheet}
					>
						{t("cameraCalibration.printMarkerSheet")}
					</button>
					{view !== null ? (
						<button
							type="button"
							className={`${styles.btn} ${styles.btnSecondary}`}
							onClick={() => setManual((m) => !m)}
						>
							{manual ? t("cameraCalibration.planeMode") : t("cameraCalibration.handMode")}
						</button>
					) : null}
					<p role="status" className={styles.hint} style={{ margin: 0, flex: "1 1 200px" }}>
						{markerResult?.kind === "found"
							? t("cameraCalibration.planeFound")
							: markerResult?.kind === "noPlane"
								? t("cameraCalibration.noPlane")
								: markerResult?.kind === "notFound"
									? t("cameraCalibration.markersNotFound")
									: null}
					</p>
				</div>
			) : null}

			{isPerspective ? (
				<div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
					<div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 10 }}>
						<span className={styles.fieldLabel}>{t("cameraCalibration.format")}</span>
						{planeMode ? (
							<>
								<ChoiceRow<PlaneFormatId>
									label={t("cameraCalibration.format")}
									columns={3}
									options={[
										{ value: "standard", label: "4:3" },
										{ value: "wide", label: "16:9" },
										{ value: "tall", label: "9:16" },
										{ value: "square", label: "1:1" },
										{ value: "free", label: t("cameraCalibration.formats.free") },
									]}
									value={planeFormat}
									onChange={selectPlaneFormat}
								/>
								{cropSizeCm ? (
									<p className={styles.hint} style={{ margin: 0 }}>
										{t("cameraCalibration.cropSize", cropSizeCm)}
									</p>
								) : null}
								{cropLeavesImage(planePerspective) ? (
									<p className={styles.hint} style={{ margin: 0 }}>
										{t("cameraCalibration.cropOutside")}
									</p>
								) : null}
							</>
						) : (
							<>
								<ChoiceRow<FormatId>
									label={t("cameraCalibration.format")}
									columns={3}
									options={[
										{ value: "a4Portrait", label: t("cameraCalibration.formats.a4Portrait") },
										{ value: "a4Landscape", label: t("cameraCalibration.formats.a4Landscape") },
										{ value: "wide", label: "16:9" },
										{ value: "standard", label: "4:3" },
										{ value: "square", label: "1:1" },
										{ value: "free", label: t("cameraCalibration.formats.free") },
									]}
									value={format}
									onChange={setFormat}
								/>
								{format === "free" ? (
									<label style={{ display: "flex", gap: 8, alignItems: "center" }}>
										<span className={styles.label}>{t("cameraCalibration.freeRatio")}</span>
										<input
											type="number"
											inputMode="decimal"
											min={MIN_ASPECT}
											max={MAX_ASPECT}
											step={0.01}
											value={freeAspect}
											onChange={(e) => setFreeAspect(e.target.value)}
											aria-invalid={aspect === null}
											aria-describedby={aspect === null ? "calibration-invalid-ratio" : undefined}
											style={{ width: 80 }}
										/>
									</label>
								) : null}
								{format === "free" && aspect === null ? (
									<p
										id="calibration-invalid-ratio"
										className={styles.hint}
										role="alert"
										style={{ margin: 0 }}
									>
										{t("cameraCalibration.invalidRatio", { min: MIN_ASPECT, max: MAX_ASPECT })}
									</p>
								) : null}
								<label style={{ display: "flex", gap: 8, alignItems: "center" }}>
									<span className={styles.label}>{t("cameraCalibration.margin")}</span>
									<input
										type="range"
										min={0}
										max={MAX_MARGIN_PCT}
										step={1}
										value={marginPct}
										onChange={(e) => setMarginPct(Number(e.target.value))}
										style={{ flex: 1 }}
									/>
									<span className={styles.label} style={{ fontVariantNumeric: "tabular-nums" }}>
										{marginPct} %
									</span>
								</label>
							</>
						)}
					</div>
					<div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 6 }}>
						<span className={styles.fieldLabel}>{t("cameraCalibration.preview")}</span>
						<canvas
							ref={previewRef}
							data-testid="calibration-preview"
							aria-label={t("cameraCalibration.preview")}
							width={preview.width}
							height={preview.height}
							style={{
								width: preview.width,
								maxWidth: "100%",
								background: "#000",
								borderRadius: 6,
							}}
						/>
					</div>
				</div>
			) : null}

			{isPerspective && !planeMode && !quadValid ? (
				<p id="calibration-invalid" className={styles.hint} role="alert" style={{ marginTop: 10 }}>
					{t("cameraCalibration.invalidQuad")}
				</p>
			) : null}

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					gap: 8,
					marginTop: 14,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={reset}
					disabled={!hasStored}
				>
					{t("cameraCalibration.reset")}
				</button>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onClose}
					>
						{tc("actions.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={apply}
						disabled={!canApply}
						aria-describedby={
							isPerspective && !planeMode && !quadValid
								? "calibration-invalid"
								: isPerspective && aspect === null
									? "calibration-invalid-ratio"
									: undefined
						}
					>
						{t("cameraCalibration.apply")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}
