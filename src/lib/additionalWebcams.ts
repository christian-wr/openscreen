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
 * Whether the desk pick names this camera: by id when both carry one, else by name. By name when
 * the camera has no id because camera 1's live identity can lack one (no track to read it off),
 * while the HUD always stores the pick under the id it enumerated. Only for the desk pick: the
 * additional cameras are resolved by `resolveAdditionalCameraPicks`.
 */
export function isDeskPickCamera(
	pick: AdditionalCameraPick,
	camera: AdditionalCameraPick,
): boolean {
	return pick.id !== null && camera.id !== null ? pick.id === camera.id : pick.name === camera.name;
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
 * `present` (the plugged-in cameras) settles camera 1 when its live identity has no id: a pick
 * with an id then reaches camera 1 by name only while no other plugged-in camera shares it.
 */
export function deskCameraIndex(
	desk: AdditionalCameraPick | null,
	camera1: AdditionalCameraPick | null,
	recorded: AdditionalCameraPick[],
	present: PresentCamera[] = [],
): number | undefined {
	if (!desk) return undefined;
	// The recorded extras first: they always carry real ids, so they match by id. Camera 1's live
	// identity may have no id and so match by name alone -- checked first, a second camera of the
	// same name (two identical webcams) would be taken for camera 1.
	const index = recorded.findIndex((camera) => isDeskPickCamera(desk, camera));
	if (index >= 0) return index + 1;
	if (!camera1) return undefined;
	if (desk.id !== null && camera1.id === null) {
		const id = camera1IdFromPresent(camera1, recorded, present);
		if (id === null) return undefined;
		if (id !== undefined) return id === desk.id ? 0 : undefined;
	}
	return isDeskPickCamera(desk, camera1) ? 0 : undefined;
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
