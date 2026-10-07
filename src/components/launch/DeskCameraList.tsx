import { Check } from "lucide-react";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import {
	type AdditionalCameraChoice,
	type AdditionalCamerasClasses,
	isSameCamera,
	MAX_ADDITIONAL_CAMERAS,
	presentAdditionalCameras,
} from "./AdditionalCamerasList";
import styles from "./LaunchWindow.module.css";

export interface DeskCameraLabels {
	title: string;
	none: string;
	/** Shown while the list is disabled: why it cannot be used here. */
	hint: string;
}

/** The additional cameras' class names, plus one for the group that wraps the list. */
export type DeskCameraClasses = AdditionalCamerasClasses & { group?: string };

interface DeskCameraListProps {
	devices: CameraDevice[];
	/** Camera 1, the first camera a take records. */
	primaryDeviceId: string | undefined;
	/** The additional cameras picked, in the order they are recorded. */
	additional: AdditionalCameraChoice[];
	selected: AdditionalCameraChoice | null;
	onChange: (next: AdditionalCameraChoice | null) => void;
	disabled: boolean;
	labels: DeskCameraLabels;
	classes?: DeskCameraClasses;
}

/**
 * The cameras a take will record, in recorded order: camera 1, then the additional cameras that
 * are plugged in. The desk camera can only be one of them.
 */
function recordedCameras(
	devices: CameraDevice[],
	primaryDeviceId: string | undefined,
	additional: AdditionalCameraChoice[],
): CameraDevice[] {
	const camera1 = devices.find((device) => device.deviceId === primaryDeviceId);
	if (!camera1) return [];
	const extras = presentAdditionalCameras(devices, primaryDeviceId, additional)
		.slice(0, MAX_ADDITIONAL_CAMERAS)
		.flatMap((choice) => devices.find((device) => isSameCamera(choice, device)) ?? []);
	return [camera1, ...extras];
}

/**
 * Radio list for the desk camera: "None" or one of the cameras the take records. Stored by the
 * camera's current id and name, like the additional cameras. A stored pick that is not among the
 * recorded cameras reads as "None": the recorder will not find it either.
 */
export function DeskCameraList({
	devices,
	primaryDeviceId,
	additional,
	selected,
	onChange,
	disabled,
	labels,
	classes,
}: DeskCameraListProps) {
	const cameras = recordedCameras(devices, primaryDeviceId, additional);
	// A single camera is all of the take: there is nothing to tell apart.
	if (cameras.length < 2) return null;
	const chosen = selected
		? (cameras.find((device) => isSameCamera(selected, device)) ?? null)
		: null;

	const entries: Array<{ key: string; label: string; device: CameraDevice | null }> = [
		{ key: "none", label: labels.none, device: null },
		...cameras.map((device) => ({ key: device.deviceId, label: device.label, device })),
	];

	return (
		<div role="group" aria-label={labels.title} className={classes?.group}>
			<div className={classes?.title ?? styles.hudMenuSectionLabel}>{labels.title}</div>
			{entries.map(({ key, label, device }) => {
				const isOn = device === chosen;
				return (
					<button
						key={key}
						type="button"
						role="menuitemradio"
						aria-checked={isOn}
						disabled={disabled}
						onClick={() => {
							if (disabled) return;
							onChange(device ? { id: device.deviceId, name: device.label } : null);
						}}
						className={`${classes?.item ?? styles.languageMenuItem} ${
							isOn ? (classes?.itemActive ?? styles.languageMenuItemActive) : ""
						}`}
					>
						<span className="truncate">{label}</span>
						{isOn ? <Check size={14} className="text-white/85" /> : null}
					</button>
				);
			})}
			{disabled ? <div className={classes?.hint ?? styles.hudModalHint}>{labels.hint}</div> : null}
		</div>
	);
}
