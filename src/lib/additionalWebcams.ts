export interface AdditionalCameraPick {
	id: string | null;
	name: string;
}

export interface PresentCamera {
	deviceId: string;
	label: string;
}

const MAX_ADDITIONAL_WEBCAMS = 3;

/**
 * The saved picks that resolve to a camera that is plugged in now, each paired with that camera,
 * in the order of the picks. A pick is matched by id first and by name second, because an id can
 * change between sessions. A stale id among several cameras with the same label goes to the first
 * of them in enumeration order (`present` order), whether or not that one is camera 1 — when it
 * is, the pick is dropped rather than moved to the next camera with that label. Camera 1, a camera
 * an earlier pick already took, and anything past the cap are left out.
 *
 * This is the one place picks are resolved: the recording request and the camera list both read
 * it, so the list shows checked exactly the cameras the recording will take.
 */
export function resolveAdditionalCameraPicks<
	P extends AdditionalCameraPick,
	C extends PresentCamera,
>(picks: P[], present: C[], primaryDeviceId: string | undefined): Array<{ pick: P; device: C }> {
	const resolved: Array<{ pick: P; device: C }> = [];
	for (const pick of picks) {
		if (resolved.length >= MAX_ADDITIONAL_WEBCAMS) break;
		const device =
			(pick.id !== null
				? present.find((candidate) => candidate.deviceId === pick.id)
				: undefined) ?? present.find((candidate) => candidate.label === pick.name);
		if (!device || device.deviceId === primaryDeviceId) continue;
		if (resolved.some((entry) => entry.device.deviceId === device.deviceId)) continue;
		resolved.push({ pick, device });
	}
	return resolved;
}

/** The cameras 2-4 of a native Windows request, under the id and label the system reports now. */
export function resolveAdditionalWebcams(
	picks: AdditionalCameraPick[],
	present: PresentCamera[],
	primaryDeviceId: string | undefined,
): Array<{ deviceId: string; deviceName: string }> {
	return resolveAdditionalCameraPicks(picks, present, primaryDeviceId).map(({ device }) => ({
		deviceId: device.deviceId,
		deviceName: device.label,
	}));
}

/**
 * Camera 1's id when its live identity has none: the one plugged-in camera of its name that is
 * not recorded as an extra. `null` when that is ambiguous (two identical webcams), `undefined`
 * when the plugged-in cameras do not say (none of them carries the name).
 */
function camera1IdFromPresent(
	camera1: AdditionalCameraPick,
	recorded: AdditionalCameraPick[],
	present: PresentCamera[],
): string | null | undefined {
	const candidates = present.filter(
		(device) =>
			device.label === camera1.name && !recorded.some((extra) => extra.id === device.deviceId),
	);
	if (candidates.length === 0) return undefined;
	return candidates.length === 1 ? candidates[0].deviceId : null;
}

/**
 * Index of the desk camera among the cameras of a take, in recorded order: 0 for camera 1, k for
 * the k-th additional camera. Undefined when there is no desk camera or it is not recorded.
 *
 * This is the one place the desk pick is resolved: the HUD's desk list and the recording request
 * both read it. It follows `resolveAdditionalCameraPicks`: by id first, and by name only once the
 * id is gone (no plugged-in camera carries it). By name, the recorded extras come first in recorded
 * order, then camera 1 -- and camera 1 only while no other plugged-in camera shares its name.
 * `present` is the plugged-in cameras; it also settles camera 1's id when its live identity has
 * none (no track to read it off).
 */
export function deskCameraIndex(
	desk: AdditionalCameraPick | null,
	camera1: AdditionalCameraPick | null,
	recorded: AdditionalCameraPick[],
	present: PresentCamera[] = [],
): number | undefined {
	if (!desk) return undefined;
	const camera1Id = camera1
		? (camera1.id ?? camera1IdFromPresent(camera1, recorded, present))
		: null;
	if (desk.id !== null) {
		const index = recorded.findIndex((camera) => camera.id === desk.id);
		if (index >= 0) return index + 1;
		if (camera1 && camera1Id === desk.id) return 0;
		// Camera 1's id cannot be told (no id, and no plugged-in camera of its name): it may be the
		// pick's id, so the name decides as it always did.
		if (camera1 && camera1Id === undefined) return camera1.name === desk.name ? 0 : undefined;
		// Camera 1 could be either of two identical webcams: no guess.
		if (camera1 && camera1Id === null) return undefined;
		// The id is on a plugged-in camera that is not recorded: that camera is the pick.
		if (present.some((device) => device.deviceId === desk.id)) return undefined;
	}
	const byName = recorded.findIndex((camera) => camera.name === desk.name);
	if (byName >= 0) return byName + 1;
	if (!camera1 || camera1.name !== desk.name || camera1Id === null) return undefined;
	const sharesName = present.some(
		(device) =>
			device.label === desk.name &&
			device.deviceId !== camera1Id &&
			!recorded.some((extra) => extra.id === device.deviceId),
	);
	return sharesName ? undefined : 0;
}

/**
 * The camera fields of a native Windows request beside camera 1: cameras 2-4 that are plugged in
 * and the desk camera's index among the recorded cameras (only with at least two of them). Each key is left out when it has
 * nothing to say, so a request with camera 1 alone looks as it always did.
 */
export function nativeRequestCameraFields(
	additionalPicks: AdditionalCameraPick[],
	deskPick: AdditionalCameraPick | null,
	present: PresentCamera[],
	camera1: { deviceId?: string; deviceName?: string },
): {
	additionalWebcams?: Array<{ deviceId: string; deviceName: string }>;
	deskCamera?: number;
} {
	const additionalWebcams = resolveAdditionalWebcams(additionalPicks, present, camera1.deviceId);
	// A desk camera needs a second camera to be one: a take with camera 1 alone has none.
	const deskCamera =
		additionalWebcams.length > 0
			? deskCameraIndex(
					deskPick,
					{ id: camera1.deviceId ?? null, name: camera1.deviceName ?? "" },
					additionalWebcams.map((extra) => ({ id: extra.deviceId, name: extra.deviceName })),
					present,
				)
			: undefined;
	return {
		...(additionalWebcams.length > 0 ? { additionalWebcams } : {}),
		...(deskCamera !== undefined ? { deskCamera } : {}),
	};
}
