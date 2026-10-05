// A still picture of a video at one time, for thumbnails and calibration. The renderer runs
// without web security, so a local `file://` video drawn to a canvas is not tainted and its
// pixels can be read (the webcam framing preview relies on the same).

const DEFAULT_TIMEOUT_MS = 8000;

/** Seeks an offscreen video to `timeSec` and draws that frame, scaled to `maxSide` if given. */
function drawFrame(
	src: string,
	timeSec: number,
	maxSide: number | undefined,
	timeoutMs: number,
): Promise<HTMLCanvasElement> {
	return new Promise((resolve, reject) => {
		if (typeof document === "undefined" || !src) {
			reject(new Error("Cannot grab a video frame: no source"));
			return;
		}
		const video = document.createElement("video");
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			video.onloadedmetadata = null;
			video.onseeked = null;
			video.onerror = null;
			try {
				video.removeAttribute("src");
				video.load();
			} catch {
				// ignore: the browser may refuse on a detached element
			}
		};
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};
		timer = setTimeout(() => fail(`Timed out grabbing a video frame from ${src}`), timeoutMs);
		video.onerror = () => fail(`Could not load the video to grab a frame from ${src}`);
		video.onloadedmetadata = () => {
			const duration = Number.isFinite(video.duration) ? video.duration : timeSec;
			// A hair before the end: seeking exactly to it can leave no frame to draw.
			video.currentTime = Math.max(0, Math.min(timeSec, Math.max(0, duration - 0.001)));
		};
		video.onseeked = () => {
			if (settled) return;
			const { videoWidth, videoHeight } = video;
			if (!(videoWidth > 0 && videoHeight > 0)) {
				fail(`The video has no picture at ${timeSec}s: ${src}`);
				return;
			}
			const scale = maxSide ? Math.min(1, maxSide / Math.max(videoWidth, videoHeight)) : 1;
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(videoWidth * scale));
			canvas.height = Math.max(1, Math.round(videoHeight * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				fail("Cannot grab a video frame: no 2D canvas");
				return;
			}
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			settled = true;
			cleanup();
			resolve(canvas);
		};
		video.src = src;
	});
}

/** The frame at `timeSec` as pixels; `maxSide` bounds the longer side (full size without it). */
export async function grabFrame(
	src: string,
	timeSec: number,
	maxSide?: number,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ImageData> {
	const canvas = await drawFrame(src, timeSec, maxSide, timeoutMs);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Cannot read a video frame: no 2D canvas");
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** The frame at `timeSec` as a PNG data URL, 96 px on its longer side unless told otherwise. */
export async function grabFrameDataUrl(
	src: string,
	timeSec: number,
	maxSide = 96,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const canvas = await drawFrame(src, timeSec, maxSide, timeoutMs);
	return canvas.toDataURL("image/png");
}
