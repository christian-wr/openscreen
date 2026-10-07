// The main camera: the camera that plays camera 1's role in the scene (the PiP, Full Camera,
// the layout pane's controls). Stored as `legacyEditor.mainCamera` (index, 0 = camera 1);
// every other index in the document still names the device, never the role.

import type { CameraSettings } from "@/components/video-editor/types";
import type { AxcutAsset, AxcutDocument } from "./ai-edition/schema";
import { projectCameraAvailable, projectCameraCount } from "./ai-edition/timeline/cameraList";
import { normalizeCameraSettings } from "./cameraLayouts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The camera that plays the main role: the chosen one when it is an integer index of the
 * project and available (the same rule as the desk camera), otherwise camera 1 (index 0).
 */
export function resolveMainCamera(input: {
	mainCamera: unknown;
	cameraCount: number;
	available: (index: number) => boolean;
}): number {
	const { mainCamera, cameraCount, available } = input;
	if (
		typeof mainCamera === "number" &&
		Number.isInteger(mainCamera) &&
		mainCamera >= 0 &&
		mainCamera < cameraCount &&
		available(mainCamera)
	) {
		return mainCamera;
	}
	return 0;
}

function swapIndex(index: unknown, main: number): unknown {
	if (index === 0) return main;
	if (index === main) return 0;
	return index;
}

function swapAssetTracks(asset: AxcutAsset, main: number): AxcutAsset {
	const extras = asset.additionalCameraTracks;
	const promoted = extras?.[main - 1];
	if (!asset.cameraTrack || !extras || !promoted) return asset;
	const { label: _label, ...asCameraOne } = promoted;
	const nextExtras = [...extras];
	nextExtras[main - 1] = { ...asset.cameraTrack, label: "" };
	return { ...asset, cameraTrack: asCameraOne, additionalCameraTracks: nextExtras };
}

/**
 * Settings after the swap. The layout pane's legacy fields now drive the main camera at
 * index 0, so the new entry 0 keeps only the main camera's perspective; the real camera 1
 * moves to `main` with its whole entry. Empty entries are stored as `null` and trailing ones
 * dropped, as `patchCameraSettings` does; `undefined` means nothing is left to store.
 */
function swapCameraSettings(raw: unknown, main: number): (CameraSettings | null)[] | undefined {
	const list = normalizeCameraSettings(raw);
	while (list.length <= main) list.push(null);
	const cameraOne = list[0];
	const promoted = list[main];
	list[0] = promoted?.perspective ? { perspective: promoted.perspective } : null;
	list[main] = cameraOne;
	const cleaned = list.map((entry) => (entry && Object.keys(entry).length > 0 ? entry : null));
	while (cleaned.length > 0 && cleaned[cleaned.length - 1] === null) cleaned.pop();
	return cleaned.length > 0 ? cleaned : undefined;
}

function swapLayoutRegions(raw: unknown, main: number): unknown {
	if (!Array.isArray(raw)) return raw;
	return raw.map((region) => {
		if (!isRecord(region) || !Array.isArray(region.slots)) return region;
		return {
			...region,
			slots: region.slots.map((slot) =>
				isRecord(slot) ? { ...slot, camera: swapIndex(slot.camera, main) } : slot,
			),
		};
	});
}

/**
 * The document as the scene should see it: when a main camera other than camera 1 is set
 * (and resolves), cameras 0 and `main` trade places in the tracks, the per-camera settings,
 * the layout sections and the desk camera, and `mainCamera` is dropped. Without one the
 * same object is returned.
 */
export function withMainCamera(document: AxcutDocument): AxcutDocument {
	const legacy = document.legacyEditor;
	if (!isRecord(legacy)) return document;
	const main = resolveMainCamera({
		mainCamera: legacy.mainCamera,
		cameraCount: projectCameraCount(document.assets),
		available: (index) => projectCameraAvailable(document.assets, index),
	});
	if (main === 0) return document;

	const { mainCamera: _mainCamera, ...nextLegacy } = legacy;
	if ("cameraSettings" in legacy) {
		const settings = swapCameraSettings(legacy.cameraSettings, main);
		if (settings) nextLegacy.cameraSettings = settings;
		else delete nextLegacy.cameraSettings;
	}
	if ("cameraLayoutRegions" in legacy) {
		nextLegacy.cameraLayoutRegions = swapLayoutRegions(legacy.cameraLayoutRegions, main);
	}
	if (typeof legacy.deskCamera === "number") {
		nextLegacy.deskCamera = swapIndex(legacy.deskCamera, main);
	}

	return {
		...document,
		assets: document.assets.map((asset) => swapAssetTracks(asset, main)),
		legacyEditor: nextLegacy,
	};
}
