// What the user is told when adding a Full Camera or layout section does not happen.

import { toast } from "sonner";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type CameraSectionOutcome = "added" | "occupied" | "no-camera" | "too-few-cameras";

/** The notice for an outcome, or `null` when the section was added. */
export function cameraSectionNotice(
	outcome: CameraSectionOutcome,
	t: Translate,
): { title: string; description?: string } | null {
	switch (outcome) {
		case "added":
			return null;
		// Neutral on purpose: what is in the way may be a Full Camera or a layout section, and
		// the refused add or paste may be either kind too.
		case "occupied":
			return {
				title: t("errors.cannotPlaceCameraSection"),
				description: t("errors.cameraSectionExistsAtLocation"),
			};
		case "too-few-cameras":
			return { title: t("errors.tooFewCameras") };
		case "no-camera":
			return { title: t("errors.noCamera") };
	}
}

/** Show the notice for an outcome (nothing for "added"). `t` is the timeline namespace. */
export function showCameraSectionOutcome(outcome: CameraSectionOutcome, t: Translate): void {
	const notice = cameraSectionNotice(outcome, t);
	if (!notice) return;
	toast.error(notice.title, notice.description ? { description: notice.description } : undefined);
}
