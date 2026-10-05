// The cameras of a project, as the editor lists them: index 0 = camera 1 (`asset.cameraTrack`),
// index k >= 1 = `asset.additionalCameraTracks[k - 1]`.

import { MAX_CAMERAS } from "@/lib/cameraLayouts";
import type { AxcutAsset, AxcutDocument } from "../schema";
import { locateVirtualPosition } from "./virtual-preview";

export interface ProjectCamera {
	index: number;
	label: string;
	path: string;
	available: boolean;
	width?: number;
	height?: number;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Every camera is named by its ordinal ("Camera 2"); an extra camera with a device label adds
 * it ("Camera 2 · Logitech C920"), so two cameras of the same model stay apart. Camera 1
 * carries no label.
 */
export function projectCameras(asset: AxcutAsset | undefined, t: Translate): ProjectCamera[] {
	if (!asset) return [];
	const tracks = [asset.cameraTrack, ...(asset.additionalCameraTracks ?? [])].slice(0, MAX_CAMERAS);
	const cameras: ProjectCamera[] = [];
	tracks.forEach((track, index) => {
		if (!track) return;
		const own = index > 0 ? String((track as { label?: string }).label ?? "").trim() : "";
		const camera: ProjectCamera = {
			index,
			label: own
				? t("cameras.cameraNamed", { n: index + 1, label: own })
				: t("cameras.cameraN", { n: index + 1 }),
			path: track.sourcePath,
			available: track.visible && track.sourcePath.length > 0,
		};
		if (track.width !== undefined) camera.width = track.width;
		if (track.height !== undefined) camera.height = track.height;
		cameras.push(camera);
	});
	return cameras;
}

/** The cameras of the asset whose clip is under the playhead (empty without a clip). */
export function camerasForClipAt(
	document: AxcutDocument,
	timelineSec: number,
	t: Translate,
): ProjectCamera[] {
	const position = locateVirtualPosition(document.timeline.clips, timelineSec);
	if (!position) return [];
	return projectCameras(
		document.assets.find((a) => a.id === position.clip.assetId),
		t,
	);
}

/**
 * The cameras of the asset a camera section is anchored to (its row's `assetId`). A row
 * without an anchor (hand-written or legacy) falls back to the clip under its middle, so a
 * section touching a cut is not taken for its neighbour's.
 */
export function camerasOfSection(
	document: AxcutDocument,
	row: { assetId?: string; startMs: number; endMs: number },
	t: Translate,
): ProjectCamera[] {
	if (row.assetId !== undefined) {
		return projectCameras(
			document.assets.find((a) => a.id === row.assetId),
			t,
		);
	}
	return camerasForClipAt(document, (row.startMs + row.endMs) / 2000, t);
}
