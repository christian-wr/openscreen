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
