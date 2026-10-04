/**
 * Pure helpers for recording several cameras with the native Windows helper.
 *
 * Camera 1 stays exactly what it always was: the helper's legacy `webcam*`
 * fields, the file `<prefix><id>-webcam.mp4` and the session's
 * `webcamVideoPath`. Cameras 2-4 ride along in the helper's `webcams` list and
 * in the session's `additionalWebcams`. Kept out of `electron/ipc/handlers.ts`
 * because that module cannot be loaded from a test.
 */
import path from "node:path";
import { type AdditionalWebcam, MAX_ADDITIONAL_WEBCAMS } from "../../src/lib/recordingSession";

/** `-webcam` (camera 1) or `-webcam-<2..9>` at the end of a file's base name. */
const WEBCAM_SUFFIX = /-webcam(?:-[2-9])?$/;

/** Camera 1 → `<prefix><id>-webcam.mp4`, camera n ≥ 2 → `<prefix><id>-webcam-<n>.mp4`. */
export function webcamOutputPath(
	dir: string,
	prefix: string,
	recordingId: number,
	cameraNumber: number,
): string {
	const suffix = cameraNumber <= 1 ? "-webcam" : `-webcam-${cameraNumber}`;
	return path.join(dir, `${prefix}${recordingId}${suffix}.mp4`);
}

/** Whether a file name is one of a recording's camera files (any extension). */
export function isWebcamSidecarFile(fileName: string): boolean {
	return WEBCAM_SUFFIX.test(path.parse(fileName).name);
}

/** The recording's base name for a camera file's base name; other names pass through. */
export function stripWebcamSuffix(baseName: string): string {
	return baseName.replace(WEBCAM_SUFFIX, "");
}

/** One camera in the helper config's `webcams` list (keys are the helper's). */
export interface HelperWebcamEntry {
	camDeviceId: string | null;
	camDeviceName: string;
	camClsid: string | null;
	camWidth: number;
	camHeight: number;
	camFps: number;
	camPath: string;
}

type DeviceRef = { deviceId?: string; deviceName?: string };

/** Same device: by id when both sides carry one, otherwise by name. */
function isSameDevice(a: DeviceRef, b: DeviceRef) {
	if (a.deviceId && b.deviceId) {
		return a.deviceId === b.deviceId;
	}
	const name = a.deviceName?.trim();
	return Boolean(name) && name === b.deviceName?.trim();
}

/**
 * The additional cameras worth asking the helper for: no malformed entry, no
 * entry that names no device, none equal to camera 1, no duplicates, and at most
 * {@link MAX_ADDITIONAL_WEBCAMS}.
 */
export function dedupeAdditionalWebcams<T extends { deviceId?: string; deviceName: string }>(
	camera1: DeviceRef | null,
	extras: T[],
): T[] {
	const kept: T[] = [];
	for (const extra of extras) {
		if (kept.length >= MAX_ADDITIONAL_WEBCAMS) {
			break;
		}
		// The list crosses IPC, so a malformed entry is skipped rather than trusted.
		if (
			!extra ||
			typeof extra.deviceName !== "string" ||
			(extra.deviceId !== undefined && typeof extra.deviceId !== "string")
		) {
			continue;
		}
		if (!extra.deviceId && !extra.deviceName.trim()) {
			continue;
		}
		if (camera1 && isSameDevice(camera1, extra)) {
			continue;
		}
		if (kept.some((other) => isSameDevice(other, extra))) {
			continue;
		}
		kept.push(extra);
	}
	return kept;
}

/**
 * Labels of the additional cameras, in order: the device name, else
 * `Camera <n>` (n counts camera 1, so the first extra is camera 2).
 *
 * Two webcams of the same model report the same name, and a label is all the
 * user is told about a camera that could not be opened or was dropped. So a
 * label already used — by camera 1 or an earlier extra — gets " (2)", " (3)"
 * by occurrence. Camera 1's own label is never changed.
 */
export function additionalWebcamLabels(
	camera1Name: string | undefined,
	extras: Array<{ deviceName: string }>,
): string[] {
	const seen = new Map<string, number>();
	const camera1Label = camera1Name?.trim();
	if (camera1Label) {
		seen.set(camera1Label, 1);
	}
	return extras.map((extra, i) => {
		const label = extra.deviceName.trim() || `Camera ${i + 2}`;
		const occurrence = (seen.get(label) ?? 0) + 1;
		seen.set(label, occurrence);
		return occurrence > 1 ? `${label} (${occurrence})` : label;
	});
}

/**
 * The camera part of the helper config: the unchanged legacy `webcam*` fields
 * for camera 1 plus the `webcams` list (camera 1 first, then the extras).
 *
 * Extras are recorded only while camera 1 is on (the HUD's camera toggle
 * governs every camera), so with camera 1 off the list is empty. Every extra
 * uses camera 1's requested size and rate: the quality setting is one for all.
 */
export function buildHelperWebcamConfig(input: {
	camera1: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
	};
	camera1Clsid: string | null;
	camera1Path: string;
	extras: Array<{ deviceId?: string; deviceName: string; clsid: string | null; path: string }>;
}) {
	const { camera1 } = input;
	const entry = (
		device: { deviceId?: string; deviceName?: string },
		clsid: string | null,
		camPath: string,
	): HelperWebcamEntry => ({
		camDeviceId: device.deviceId ?? null,
		camDeviceName: device.deviceName ?? "",
		camClsid: clsid,
		camWidth: camera1.width,
		camHeight: camera1.height,
		camFps: camera1.fps,
		camPath,
	});
	const webcams: HelperWebcamEntry[] = camera1.enabled
		? [
				entry(camera1, input.camera1Clsid, input.camera1Path),
				...input.extras.map((extra) => entry(extra, extra.clsid, extra.path)),
			]
		: [];
	return {
		webcamEnabled: camera1.enabled,
		webcamDeviceId: camera1.deviceId ?? null,
		webcamDeviceName: camera1.deviceName ?? null,
		webcamDirectShowClsid: input.camera1Clsid,
		webcamWidth: camera1.width,
		webcamHeight: camera1.height,
		webcamFps: camera1.fps,
		webcams,
	};
}

/**
 * Labels of the additional cameras the helper reported unavailable. The
 * helper's index is the position in the `webcams` list, which is the position
 * in `requested` (camera 1 first). Index 0 is camera 1 and is left out: the
 * caller reports camera 1 through its own `webcamUnavailable` flag. The labels
 * come from our own list because the helper's `deviceName` can be empty.
 */
export function labelsOfUnavailableAdditionalWebcams(
	requested: Array<{ label: string }>,
	indices: number[],
): string[] {
	const labels: string[] = [];
	for (const index of new Set(indices)) {
		const camera = index > 0 ? requested[index] : undefined;
		if (camera) {
			labels.push(camera.label);
		}
	}
	return labels;
}

/**
 * Which requested cameras made it into the take.
 *
 * A camera is kept when its file exists with size > 0. The helper's own list
 * at stop is deliberately not consulted: it names the cameras still recording
 * at that moment, so a camera that died mid-take with a playable partial file
 * would be missing from it, and an old helper names only camera 1. A file that
 * never appeared is simply absent from `sizes`.
 *
 * `camera1Enabled` says whether `requested[0]` is camera 1. Camera 1 comes back
 * as `camera1` (undefined when lost) and is never in `dropped`, which names
 * only the additional cameras not kept — the caller reports camera 1 through
 * its own `webcamDropped` flag.
 */
export function collectStoppedWebcams(input: {
	camera1Enabled: boolean;
	requested: Array<{ path: string; label: string }>;
	sizes: Map<string, number>;
}): { camera1?: string; additional: AdditionalWebcam[]; dropped: string[] } {
	const isKept = (filePath: string) => (input.sizes.get(filePath) ?? 0) > 0;
	const [first, ...rest] = input.requested;
	const camera1 = input.camera1Enabled && first && isKept(first.path) ? first.path : undefined;
	const extras = input.camera1Enabled ? rest : input.requested;
	const additional: AdditionalWebcam[] = [];
	const dropped: string[] = [];
	for (const camera of extras) {
		if (isKept(camera.path)) {
			additional.push({ path: camera.path, label: camera.label });
		} else {
			dropped.push(camera.label);
		}
	}
	return { ...(camera1 ? { camera1 } : {}), additional, dropped };
}
