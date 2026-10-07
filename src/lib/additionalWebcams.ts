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
	recordedIds: string[],
	present: PresentCamera[],
): string | null | undefined {
	const candidates = present.filter(
		(device) => device.label === camera1.name && !recordedIds.includes(device.deviceId),
	);
	if (candidates.length === 0) return undefined;
	return candidates.length === 1 ? candidates[0].deviceId : null;
}

/**
 * Index of the desk camera among the cameras of a take, in recorded order: 0 for camera 1, k for
 * the k-th additional camera. Undefined when there is no desk camera or it is not recorded.
 *
 * This is the one place the desk pick is resolved: the HUD's desk list and the recording request
 * both read it. `extras` are the additional cameras exactly as `resolveAdditionalCameraPicks`
 * paired them, in recorded order; `present` is the plugged-in cameras in enumeration order.
 *
 * - By id first: a recorded extra, then camera 1. While a plugged-in camera carries the pick's id,
 *   the pick names that camera and nothing else (undefined when it is not recorded).
 * - Once the id is gone (no plugged-in camera carries it), or for a pick without one, by name as
 *   the resolver would: the extra whose saved pick has the desk pick's id (the resolver already
 *   placed that pick), else the first recorded extra of that name in enumeration order, else
 *   camera 1 -- and camera 1 only while no other plugged-in camera shares its name.
 *
 * Camera 1's live identity can lack an id (no track to read it off); `present` then supplies it.
 */
export function deskCameraIndex(
	desk: AdditionalCameraPick | null,
	camera1: AdditionalCameraPick | null,
	extras: Array<{ pick: AdditionalCameraPick; device: PresentCamera }>,
	present: PresentCamera[],
): number | undefined {
	if (!desk) return undefined;
	const recordedIds = extras.map((entry) => entry.device.deviceId);
	const camera1Id = camera1
		? (camera1.id ?? camera1IdFromPresent(camera1, recordedIds, present))
		: null;
	if (desk.id !== null) {
		const index = recordedIds.indexOf(desk.id);
		if (index >= 0) return index + 1;
		if (present.some((device) => device.deviceId === desk.id)) {
			if (camera1 && camera1Id === desk.id) return 0;
			// Camera 1's id cannot be told (no id, and no plugged-in camera of its name): it may be
			// the pick's id, so the name decides as it always did.
			if (camera1 && camera1Id === undefined) return camera1.name === desk.name ? 0 : undefined;
			// A plugged-in camera that is not recorded, or one of two identical webcams: no guess.
			return undefined;
		}
		const own = extras.findIndex((entry) => entry.pick.id === desk.id);
		if (own >= 0) return own + 1;
	}
	for (const device of present) {
		if (device.label !== desk.name) continue;
		const index = recordedIds.indexOf(device.deviceId);
		if (index >= 0) return index + 1;
	}
	if (!camera1 || camera1.name !== desk.name || camera1Id === null) return undefined;
	const sharesName = present.some(
		(device) =>
			device.label === desk.name &&
			device.deviceId !== camera1Id &&
			!recordedIds.includes(device.deviceId),
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
	const extras = resolveAdditionalCameraPicks(additionalPicks, present, camera1.deviceId);
	const additionalWebcams = extras.map(({ device }) => ({
		deviceId: device.deviceId,
		deviceName: device.label,
	}));
	// A desk camera needs a second camera to be one: a take with camera 1 alone has none.
	const deskCamera =
		extras.length > 0
			? deskCameraIndex(
					deskPick,
					{ id: camera1.deviceId ?? null, name: camera1.deviceName ?? "" },
					extras,
					present,
				)
			: undefined;
	return {
		...(additionalWebcams.length > 0 ? { additionalWebcams } : {}),
		...(deskCamera !== undefined ? { deskCamera } : {}),
	};
}
