import { useEffect, useState } from "react";
import { getPlatform } from "@/utils/platformUtils";

/**
 * Whether this machine records through the native Windows helper, the only path that can hold
 * more than one camera. `false` until the helper has answered, and for a failed probe: an option
 * that cannot work is shown disabled rather than offered.
 */
export function useNativeWindowsCaptureAvailable(): boolean {
	const [available, setAvailable] = useState(false);

	useEffect(() => {
		const probe = window.electronAPI?.isNativeWindowsCaptureAvailable;
		if (getPlatform() !== "win32" || !probe) return;
		let cancelled = false;
		void probe()
			.then((result) => {
				if (!cancelled) setAvailable(result.success && result.available);
			})
			.catch((error) => {
				console.warn("Could not probe native Windows capture:", error);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return available;
}
