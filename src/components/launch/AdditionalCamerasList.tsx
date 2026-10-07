import { Check } from "lucide-react";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import styles from "./LaunchWindow.module.css";

/** Camera 1 plus this many more is the most a recording can hold. */
export const MAX_ADDITIONAL_CAMERAS = 3;

/** A picked extra camera, stored the way the recording prefs keep it. */
export interface AdditionalCameraChoice {
	id: string | null;
	name: string;
}

export interface AdditionalCamerasLabels {
	title: string;
	/** Shown while the list is disabled: why it cannot be used here. */
	hint: string;
}

/** Class names, so the editor's Rec stage can restyle the list without a second component. */
export interface AdditionalCamerasClasses {
	title?: string;
	item?: string;
	itemActive?: string;
	hint?: string;
}

interface AdditionalCamerasListProps {
	devices: CameraDevice[];
	/** Camera 1: never offered again here. */
	primaryDeviceId: string | undefined;
	selected: AdditionalCameraChoice[];
	onChange: (next: AdditionalCameraChoice[]) => void;
	disabled: boolean;
	labels: AdditionalCamerasLabels;
	classes?: AdditionalCamerasClasses;
}

export function isSameCamera(choice: AdditionalCameraChoice, device: CameraDevice): boolean {
	return choice.id !== null ? choice.id === device.deviceId : choice.name === device.label;
}

/**
 * The picks that can be recorded: plugged in and not camera 1. A saved pick whose camera is
 * unplugged is neither shown nor counted.
 */
export function presentAdditionalCameras(
	devices: CameraDevice[],
	primaryDeviceId: string | undefined,
	selected: AdditionalCameraChoice[],
): AdditionalCameraChoice[] {
	const offered = devices.filter((device) => device.deviceId !== primaryDeviceId);
	return selected.filter((choice) => offered.some((device) => isSameCamera(choice, device)));
}

/**
 * Checkbox list for cameras 2-4. Selection keeps the order of the clicks, because that order is
 * the order the cameras get their `-webcam-N` files in.
 */
export function AdditionalCamerasList({
	devices,
	primaryDeviceId,
	selected,
	onChange,
	disabled,
	labels,
	classes,
}: AdditionalCamerasListProps) {
	const offered = devices.filter((device) => device.deviceId !== primaryDeviceId);
	const present = presentAdditionalCameras(devices, primaryDeviceId, selected);
	const full = present.length >= MAX_ADDITIONAL_CAMERAS;

	const toggle = (device: CameraDevice) => {
		if (disabled) return;
		const isOn = present.some((choice) => isSameCamera(choice, device));
		if (isOn) {
			onChange(present.filter((choice) => !isSameCamera(choice, device)));
		} else if (!full) {
			onChange([...present, { id: device.deviceId, name: device.label }]);
		}
	};

	return (
		<>
			<div className={classes?.title ?? styles.hudMenuSectionLabel}>{labels.title}</div>
			{offered.map((device) => {
				const isOn = present.some((choice) => isSameCamera(choice, device));
				const blocked = disabled || (!isOn && full);
				return (
					<button
						key={device.deviceId}
						type="button"
						role="menuitemcheckbox"
						aria-checked={isOn}
						disabled={blocked}
						onClick={() => toggle(device)}
						className={`${classes?.item ?? styles.languageMenuItem} ${
							isOn ? (classes?.itemActive ?? styles.languageMenuItemActive) : ""
						}`}
					>
						<span className="truncate">{device.label}</span>
						{isOn ? <Check size={14} className="text-white/85" /> : null}
					</button>
				);
			})}
			{disabled ? <div className={classes?.hint ?? styles.hudModalHint}>{labels.hint}</div> : null}
		</>
	);
}
