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
 * The cameras 2-4 of a native Windows request: the saved picks that are still plugged in, under
 * the id and label the system reports now (an id can change between sessions, the pick is
 * matched by id first and by name second). Camera 1, repeats and anything past the cap are left
 * out; the order of the picks is kept.
 */
export function resolveAdditionalWebcams(
	picks: AdditionalCameraPick[],
	present: PresentCamera[],
	primaryDeviceId: string | undefined,
): Array<{ deviceId: string; deviceName: string }> {
	const resolved: Array<{ deviceId: string; deviceName: string }> = [];
	for (const pick of picks) {
		if (resolved.length >= MAX_ADDITIONAL_WEBCAMS) break;
		const device =
			(pick.id !== null
				? present.find((candidate) => candidate.deviceId === pick.id)
				: undefined) ?? present.find((candidate) => candidate.label === pick.name);
		if (!device || device.deviceId === primaryDeviceId) continue;
		if (resolved.some((entry) => entry.deviceId === device.deviceId)) continue;
		resolved.push({ deviceId: device.deviceId, deviceName: device.label });
	}
	return resolved;
}

/** The same camera by the rule of the camera lists: by id when the pick has one, else by name. */
function isSameCamera(pick: AdditionalCameraPick, camera: AdditionalCameraPick): boolean {
	return pick.id !== null ? pick.id === camera.id : pick.name === camera.name;
}

/**
 * Index of the desk camera among the cameras of a take, in recorded order: 0 for camera 1, k for
 * the k-th additional camera. Undefined when there is no desk camera or it is not recorded.
 */
export function deskCameraIndex(
	desk: AdditionalCameraPick | null,
	camera1: AdditionalCameraPick | null,
	recorded: AdditionalCameraPick[],
): number | undefined {
	if (!desk) return undefined;
	if (camera1 && isSameCamera(desk, camera1)) return 0;
	const index = recorded.findIndex((camera) => isSameCamera(desk, camera));
	return index >= 0 ? index + 1 : undefined;
}
