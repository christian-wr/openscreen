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
