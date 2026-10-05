// How a layout template looks in the editor: its name (timeline scope) and its icon. Shared by
// the timeline's pills and "Add layout" menu and by the inspector.

import { Columns2, Layers, Maximize2, PictureInPicture2 } from "lucide-react";
import type { CameraLayoutTemplate } from "@/components/video-editor/types";

type Translate = (key: string) => string;

export function layoutTemplateLabel(t: Translate, template: CameraLayoutTemplate): string {
	switch (template) {
		case "screen-pip":
			return t("labels.layoutScreenPip");
		case "camera-full":
			return t("labels.layoutCameraFull");
		case "camera-full-pip":
			return t("labels.layoutCameraFullPip");
		case "side-by-side":
			return t("labels.layoutSideBySide");
	}
}

export function layoutTemplateIcon(template: CameraLayoutTemplate, size = 12) {
	switch (template) {
		case "camera-full":
			return <Maximize2 size={size} />;
		case "camera-full-pip":
			return <Layers size={size} />;
		case "side-by-side":
			return <Columns2 size={size} />;
		case "screen-pip":
			return <PictureInPicture2 size={size} />;
	}
}
