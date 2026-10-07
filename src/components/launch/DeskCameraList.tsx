import { Check } from "lucide-react";
import { deskCameraIndex, resolveAdditionalCameraPicks } from "@/lib/additionalWebcams";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import type { AdditionalCameraChoice, AdditionalCamerasClasses } from "./AdditionalCamerasList";
import styles from "./LaunchWindow.module.css";

export interface DeskCameraLabels {
	title: string;
	none: string;
	/**
	 * Shown while the list is disabled: why it cannot be used here. Left out where the additional
	 * cameras' list above is locked by the same rule and already says so.
	 */
	hint?: string;
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
 * The cameras a take will record, in recorded order: camera 1, then the additional cameras exactly
 * as `resolveAdditionalCameraPicks` resolves them -- the same devices the additional cameras' list
 * checks and the recording request carries. The desk camera can only be one of them.
 */
function recordedCameras(
	devices: CameraDevice[],
	primaryDeviceId: string | undefined,
	additional: AdditionalCameraChoice[],
): CameraDevice[] {
	const camera1 = devices.find((device) => device.deviceId === primaryDeviceId);
	if (!camera1) return [];
	const extras = resolveAdditionalCameraPicks(additional, devices, primaryDeviceId).map(
		(entry) => entry.device,
	);
	return [camera1, ...extras];
}

/**
 * Radio list for the desk camera: "None" or one of the cameras the take records. Stored by the
 * camera's current id and name, like the additional cameras, and resolved by `deskCameraIndex`
 * like the recording request. A stored pick that resolves to none of the recorded cameras reads as
 * "None": the recorder will not find it either.
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
	// The desk pick resolved exactly as the recording request resolves it (a stale id falls back
	// to the name), so the checked row is the camera the take marks as the desk camera.
	const [camera1, ...extras] = cameras.map((device) => ({
		id: device.deviceId,
		name: device.label,
	}));
	const chosenIndex = deskCameraIndex(selected, camera1, extras, devices);
	const chosen = chosenIndex !== undefined ? cameras[chosenIndex] : null;

	const entries: Array<{ key: string; label: string; device: CameraDevice | null }> = [
		{ key: "none", label: labels.none, device: null },
		...cameras.map((device) => ({ key: device.deviceId, label: device.label, device })),
	];

	return (
		<div role="radiogroup" aria-label={labels.title} className={classes?.group}>
			<div className={classes?.title ?? styles.hudMenuSectionLabel}>{labels.title}</div>
			{entries.map(({ key, label, device }) => {
				const isOn = device === chosen;
				return (
					<button
						key={key}
						type="button"
						role="radio"
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
			{disabled && labels.hint ? (
				<div className={classes?.hint ?? styles.hudModalHint}>{labels.hint}</div>
			) : null}
		</div>
	);
}
