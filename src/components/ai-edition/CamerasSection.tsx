// The "Cameras" section of the layout pane: every camera of the clip under the playhead, with
// a thumbnail and the per-camera settings. Camera 1 keeps its rotation, mirror and crop in
// the controls above (older fields), so its row only offers the perspective correction.

import { useEffect, useMemo, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { CameraSettings, CropRegion } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { assetAdditionalCameraSources, assetCameraSource } from "@/lib/ai-edition/timeline/camera";
import { camerasForClipAt, type ProjectCamera } from "@/lib/ai-edition/timeline/cameraList";
import { grabFrameDataUrl } from "@/lib/ai-edition/timeline/grabFrame";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import type { CameraRotation } from "@/lib/cameraOrientation";
import styles from "./NewEditorShell.module.css";
import { ChoiceRow, Toggle } from "./RightPanes";

/** What the calibration dialog edits: the picture's crop, or its perspective. */
export type CalibrationMode = "crop" | "perspective";

const THUMBNAIL_SIDE = 96;
/** The playhead moves every frame during playback; a still is only worth grabbing once it rests. */
const THUMBNAIL_DEBOUNCE_MS = 250;

export interface CamerasSectionProps {
	document: AxcutDocument | null;
	/** Overrides the playhead on the ruler; by default it is read from the project store here, so
	 *  only this section re-renders while the playhead moves. */
	playheadSec?: number;
	/** `legacyEditor.cameraSettings`, normalized: index 0 = camera 1. */
	cameraSettings: (CameraSettings | null)[];
	setCameraSettings: (index: number, patch: Partial<CameraSettings> | null) => void | Promise<void>;
	/** Opens the calibration dialog for a camera. */
	onOpenCalibration?: (cameraIndex: number, mode: CalibrationMode) => void;
}

export type CameraStill = { src: string; timeSec: number };

/** Where each camera's file is, and which time of it the playhead shows. */
export function stillsAt(
	document: AxcutDocument | null,
	playheadSec: number,
): Map<number, CameraStill> {
	const stills = new Map<number, CameraStill>();
	if (!document) return stills;
	const position = locateVirtualPosition(document.timeline.clips, playheadSec);
	if (!position) return stills;
	const asset = document.assets.find((a) => a.id === position.clip.assetId);
	const sources = [assetCameraSource(asset), ...assetAdditionalCameraSources(asset)];
	sources.forEach((source, index) => {
		if (!source.path) return;
		const src = /^(https?|blob|data):/.test(source.path) ? source.path : toFileUrl(source.path);
		stills.set(index, { src, timeSec: Math.max(0, position.sourceTimeSec - source.offsetSec) });
	});
	return stills;
}

/**
 * Whether a camera has a crop stored. Camera 1 keeps its crop in `webcamCropRegion` (a
 * full-frame rect means none); the others in `cameraSettings[k].crop`.
 */
export function cameraHasCrop(
	document: AxcutDocument | null,
	cameraSettings: (CameraSettings | null)[],
	index: number,
): boolean {
	if (index !== 0) return cameraSettings[index]?.crop != null;
	const legacy = document?.legacyEditor as Record<string, unknown> | null | undefined;
	const crop = legacy?.webcamCropRegion as Partial<CropRegion> | undefined;
	if (!crop) return false;
	const coversFrame = (v: unknown) => typeof v !== "number" || v >= 1 - 1e-6;
	return !(coversFrame(crop.width) && coversFrame(crop.height));
}

/** The camera the calibration dialog opens on: its label and its still at the playhead. */
export function calibrationCameraAt(
	document: AxcutDocument | null,
	playheadSec: number,
	index: number,
	t: (key: string, vars?: Record<string, string | number>) => string,
): { index: number; label: string; src: string; timeSec: number } | null {
	if (!document) return null;
	const camera = camerasForClipAt(document, playheadSec, t).find((c) => c.index === index);
	const still = stillsAt(document, playheadSec).get(index);
	if (!camera?.available || !still) return null;
	return { index, label: camera.label, ...still };
}

function CameraThumbnail({ still, label }: { still: CameraStill | undefined; label: string }) {
	const [url, setUrl] = useState<string | null>(null);
	const src = still?.src;
	const timeSec = still?.timeSec;
	useEffect(() => {
		if (src === undefined || timeSec === undefined) {
			setUrl(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			grabFrameDataUrl(src, timeSec, THUMBNAIL_SIDE)
				.then((dataUrl) => {
					if (!cancelled) setUrl(dataUrl);
				})
				.catch(() => {
					if (!cancelled) setUrl(null);
				});
		}, THUMBNAIL_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [src, timeSec]);
	return (
		<div
			style={{
				width: THUMBNAIL_SIDE,
				height: (THUMBNAIL_SIDE * 9) / 16,
				flex: "none",
				borderRadius: 6,
				background: "var(--surface-hi)",
				overflow: "hidden",
			}}
		>
			{url ? (
				<img
					src={url}
					alt={label}
					style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
				/>
			) : null}
		</div>
	);
}

const BUTTON = `${styles.btn} ${styles.btnSecondary}`;

export function CamerasSection({
	document,
	playheadSec: playheadOverride,
	cameraSettings,
	setCameraSettings,
	onOpenCalibration,
}: CamerasSectionProps) {
	const ts = useScopedT("settings");
	const storePlayheadSec = useProjectStore((s) => s.currentTimeSec);
	const playheadSec = playheadOverride ?? storePlayheadSec;
	const cameras: ProjectCamera[] = useMemo(
		() => (document ? camerasForClipAt(document, playheadSec, ts) : []),
		[document, playheadSec, ts],
	);
	const stills = useMemo(() => stillsAt(document, playheadSec), [document, playheadSec]);
	if (cameras.length === 0) return null;
	return (
		<>
			<div className={styles.sectionLabel}>{ts("cameras.title")}</div>
			{cameras.map((camera) => {
				const settings = cameraSettings[camera.index] ?? null;
				const isFirst = camera.index === 0;
				// A perspective replaces the crop at render, so the crop is not offered then.
				const hasPerspective = settings?.perspective != null;
				return (
					<div
						key={camera.index}
						data-testid={`camera-row-${camera.index}`}
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 8,
							margin: "0 var(--sp-4) 14px",
						}}
					>
						<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
							<CameraThumbnail
								still={camera.available ? stills.get(camera.index) : undefined}
								label={camera.label}
							/>
							<div style={{ minWidth: 0 }}>
								<div className={styles.label}>{camera.label}</div>
								{camera.available ? null : (
									<p className={styles.hint}>{ts("cameras.unavailable")}</p>
								)}
							</div>
						</div>
						{isFirst ? <p className={styles.hint}>{ts("cameras.camera1Hint")}</p> : null}
						{isFirst ? null : (
							<>
								<ChoiceRow<CameraRotation>
									label={ts("cameras.rotation")}
									options={[
										{ value: 0, label: "0°" },
										{ value: 180, label: "180°" },
									]}
									value={settings?.rotation ?? 0}
									onChange={(rotation) => void setCameraSettings(camera.index, { rotation })}
								/>
								<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
									<span className={styles.label}>{ts("cameras.mirror")}</span>
									<Toggle
										checked={settings?.mirror === true}
										ariaLabel={ts("cameras.mirror")}
										onChange={(mirror) => void setCameraSettings(camera.index, { mirror })}
									/>
								</div>
							</>
						)}
						<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
							{isFirst ? null : (
								<button
									type="button"
									className={BUTTON}
									disabled={!camera.available || hasPerspective}
									title={hasPerspective ? ts("cameras.cropOffWithPerspective") : undefined}
									onClick={() => onOpenCalibration?.(camera.index, "crop")}
								>
									{ts("cameras.crop")}
								</button>
							)}
							<button
								type="button"
								className={BUTTON}
								disabled={!camera.available}
								onClick={() => onOpenCalibration?.(camera.index, "perspective")}
							>
								{ts("cameras.perspective")}
							</button>
							{!isFirst && settings ? (
								<button
									type="button"
									className={BUTTON}
									onClick={() => void setCameraSettings(camera.index, null)}
								>
									{ts("cameras.reset")}
								</button>
							) : null}
						</div>
						{!isFirst && hasPerspective ? (
							<p className={styles.hint}>{ts("cameras.cropOffWithPerspective")}</p>
						) : null}
					</div>
				);
			})}
		</>
	);
}
