/** A recorded camera beyond camera 1 (which stays `webcamVideoPath`). */
export interface AdditionalWebcam {
	path: string;
	label: string;
}

/** Camera 1 plus at most this many additional cameras (4 in total). */
export const MAX_ADDITIONAL_WEBCAMS = 3;

export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	/**
	 * Milliseconds to shift the webcam asset's playback position relative to
	 * the screen recording. Negative when the webcam started capturing before
	 * the screen recording's real start (e.g. the browser MediaRecorder for
	 * the webcam is started in the renderer before the native Windows helper
	 * process finishes spawning and confirms recording), so the editor skips
	 * that much extra leading footage instead of showing stale camera frames.
	 */
	webcamOffsetMs?: number;
	/** Cameras 2-4, in recording order. Omitted when there are none. */
	additionalWebcams?: AdditionalWebcam[];
	cursorCaptureMode?: CursorCaptureMode;
}

export type CursorCaptureMode = "editable-overlay" | "system";

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Recording wall-clock duration (ms). The main process patches the WebM Duration
	 * header on streamed recordings (the renderer no longer holds the bytes). Browser
	 * MediaRecorder writes no/zero duration, which breaks the editor seek bar and
	 * timeline for anything that took the streaming path.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeAdditionalWebcams(value: unknown): AdditionalWebcam[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const result: AdditionalWebcam[] = [];
	for (const entry of value) {
		if (result.length >= MAX_ADDITIONAL_WEBCAMS) {
			break;
		}
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const raw = entry as Partial<AdditionalWebcam>;
		const entryPath = normalizePath(raw.path);
		if (!entryPath) {
			continue;
		}
		result.push({ path: entryPath, label: typeof raw.label === "string" ? raw.label : "" });
	}
	return result;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const additionalWebcams = normalizeAdditionalWebcams(raw.additionalWebcams);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);
	const webcamOffsetMs =
		typeof raw.webcamOffsetMs === "number" && Number.isFinite(raw.webcamOffsetMs)
			? raw.webcamOffsetMs
			: undefined;

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
		...(additionalWebcams.length > 0 ? { additionalWebcams } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
	};
}

/** Result of the `find-recording-camera` IPC, shared by the handler and the renderer typing. */
export interface FindRecordingCameraResult {
	success: boolean;
	webcamVideoPath?: string;
	offsetMs?: number;
	/** Cameras 2-4 of the same recording, already approved for reading. */
	additionalWebcams?: AdditionalWebcam[];
	error?: string;
}
