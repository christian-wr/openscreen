// The inspector pane of a layout section: its template, one camera per place, and the
// section's own actions. The Full Camera pane reuses `LayoutTemplateChoice`.

import { RotateCcw, Trash2 } from "lucide-react";
import { useId } from "react";
import type { CameraLayoutRegion, CameraLayoutTemplate } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import type { ProjectCamera } from "@/lib/ai-edition/timeline/cameraList";
import {
	LAYOUT_TEMPLATES,
	type LayoutTemplateBlock,
	layoutTemplateBlock,
} from "@/lib/ai-edition/timeline/layoutMenu";
import { TEMPLATE_SLOTS } from "@/lib/cameraLayouts";
import shell from "../NewEditorShell.module.css";
import { ChoiceRow, Toggle } from "../RightPanes";
import { layoutTemplateIcon, layoutTemplateLabel } from "./layoutTemplateUi";
import { PANE_BODY_STYLE, PANE_BUTTON, paneHeader, paneStack } from "./paneParts";

type TimelineApi = ReturnType<typeof useTimeline>;

/** The four templates as one choice row; the ones that cannot apply are disabled, with the reason. */
export function LayoutTemplateChoice({
	current,
	cameraCount,
	blockPreset,
	onPick,
}: {
	current: CameraLayoutTemplate;
	/** How many cameras the section could show: its own plus the clip's available ones. */
	cameraCount: number;
	blockPreset: boolean;
	onPick: (template: CameraLayoutTemplate) => void;
}) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const hintId = useId();
	const blocks = new Map<CameraLayoutTemplate, LayoutTemplateBlock>();
	for (const template of LAYOUT_TEMPLATES) {
		// The template in use stays pickable: it is where the section already is.
		const block =
			template === current ? null : layoutTemplateBlock(template, { cameraCount, blockPreset });
		if (block) blocks.set(template, block);
	}
	const hintFor = (block: LayoutTemplateBlock) =>
		block === "block-layout" ? tt("layoutMenu.blockLayoutHint") : tt("layoutMenu.needsCamerasHint");
	const reasons = [...new Set(blocks.values())];
	return paneStack(
		ts("cameraLayout.template"),
		<>
			<ChoiceRow<CameraLayoutTemplate>
				label={ts("cameraLayout.template")}
				columns={2}
				display="both"
				describedBy={reasons.length > 0 ? hintId : undefined}
				options={LAYOUT_TEMPLATES.map((template) => {
					const block = blocks.get(template);
					return {
						value: template,
						label: layoutTemplateLabel(tt, template),
						icon: layoutTemplateIcon(template, 14),
						disabled: block !== undefined,
						title: block ? hintFor(block) : null,
					};
				})}
				value={current}
				onChange={onPick}
			/>
			{reasons.length > 0 ? (
				<span id={hintId} style={{ fontSize: 12, color: "var(--muted)" }}>
					{reasons.map(hintFor).join(" · ")}
				</span>
			) : null}
		</>,
	);
}

/** "Place 1 · large": the template says which places are big and which are small. */
function placeLabel(
	ts: (key: string, vars?: Record<string, string | number>) => string,
	template: CameraLayoutTemplate,
	index: number,
): string {
	const n = index + 1;
	if (template === "side-by-side") {
		return ts(index === 0 ? "cameraLayout.placeLeft" : "cameraLayout.placeRight", { n });
	}
	const large = template === "camera-full" || (template === "camera-full-pip" && index === 0);
	return ts(large ? "cameraLayout.placeLarge" : "cameraLayout.placeSmall", { n });
}

/**
 * "Screen + camera" as one switch per camera: on = the camera has a window. Each click is
 * written as that one switch, so clicks faster than a save each build on the one before.
 * The section keeps between one and three windows; the switches that would break that are
 * locked, with the reason below, which they name as their description.
 */
function SectionCameraSwitches({
	region,
	cameras,
	onToggle,
}: {
	region: CameraLayoutRegion;
	cameras: ProjectCamera[];
	onToggle: (camera: number, on: boolean) => void;
}) {
	const ts = useScopedT("settings");
	const hintId = useId();
	const on = region.slots.map((slot) => slot.camera);
	const { min, max } = TEMPLATE_SLOTS[region.template];
	// A camera the section shows but the clip no longer has stays listed, so it can be switched off.
	const rows = [
		...cameras,
		...on
			.filter((index) => !cameras.some((c) => c.index === index))
			.map((index) => ({
				index,
				label: ts("cameras.cameraN", { n: index + 1 }),
				available: false,
			})),
	];
	const atMin = on.length <= min;
	// The cap is only worth saying while a camera that is off is held back by it.
	const atMax = on.length >= max && rows.some((c) => !on.includes(c.index));
	return paneStack(
		ts("cameras.title"),
		<>
			{rows.map((camera) => {
				const checked = on.includes(camera.index);
				const locked = checked ? atMin : atMax || !camera.available;
				// The hint explains the min/max lock; an unavailable camera says so in its label.
				const lockedByHint = checked ? atMin : atMax;
				return (
					<div
						key={camera.index}
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							gap: 12,
						}}
					>
						<span>
							{camera.available
								? camera.label
								: ts("cameraLayout.cameraUnavailable", { name: camera.label })}
						</span>
						<Toggle
							checked={checked}
							disabled={locked}
							ariaLabel={camera.label}
							describedBy={lockedByHint ? hintId : undefined}
							onChange={(next) => onToggle(camera.index, next)}
						/>
					</div>
				);
			})}
			{atMin || atMax ? (
				<span id={hintId} style={{ fontSize: 12, color: "var(--muted)" }}>
					{atMin ? ts("layoutSection.minOneCamera") : ts("layoutSection.maxThreeWindows")}
				</span>
			) : null}
		</>,
	);
}

export function LayoutSectionPane({
	tl,
	region,
	cameras,
	blockPreset,
	toggleSectionCamera,
	onClose,
}: {
	tl: Pick<
		TimelineApi,
		| "setLayoutTemplate"
		| "setLayoutSlotCamera"
		| "resetLayoutSlotRects"
		| "removeRegion"
		| "selectRegion"
	>;
	region: CameraLayoutRegion;
	/** The cameras of the clip the section sits on. */
	cameras: ProjectCamera[];
	blockPreset: boolean;
	/** Writes one camera switch of the section; the shell's queued writer. */
	toggleSectionCamera: TimelineApi["toggleLayoutSectionCamera"];
	onClose: () => void;
}) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	const handle = { kind: "cameraLayout" as const, id: region.id };
	const own = region.slots.map((slot) => slot.camera);
	const available = cameras.filter((c) => c.available).map((c) => c.index);
	const cameraCount = new Set([...own, ...available]).size;
	const followHandle = (next: { kind: "cameraFullscreen" | "cameraLayout"; id: string }) => {
		if (next.kind !== handle.kind || next.id !== handle.id) tl.selectRegion(next.kind, next.id);
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			{paneHeader(
				layoutTemplateIcon(region.template, 16),
				layoutTemplateLabel(tt, region.template),
				onClose,
				tc("actions.close"),
			)}
			<div style={PANE_BODY_STYLE}>
				<LayoutTemplateChoice
					current={region.template}
					cameraCount={cameraCount}
					blockPreset={blockPreset}
					onPick={(template) =>
						void tl.setLayoutTemplate(handle, template, available).then(followHandle)
					}
				/>
				{region.template === "screen-pip" ? (
					<SectionCameraSwitches
						region={region}
						cameras={cameras}
						onToggle={(camera, on) => void toggleSectionCamera(handle, camera, on)}
					/>
				) : (
					region.slots.map((slot, index) => {
						const label = placeLabel(ts, region.template, index);
						const known = cameras.some((c) => c.index === slot.camera);
						return (
							// A place has no id of its own; its position is its identity.
							<div key={index}>
								{paneStack(
									label,
									<select
										className={shell.control}
										aria-label={label}
										value={slot.camera}
										onChange={(e) =>
											void tl
												.setLayoutSlotCamera(handle, index, Number(e.target.value))
												.then(followHandle)
										}
									>
										{cameras.map((camera) => (
											<option
												key={camera.index}
												value={camera.index}
												disabled={!camera.available && camera.index !== slot.camera}
											>
												{camera.available
													? camera.label
													: ts("cameraLayout.cameraUnavailable", { name: camera.label })}
											</option>
										))}
										{known ? null : (
											<option value={slot.camera} disabled>
												{ts("cameraLayout.cameraUnavailable", {
													name: ts("cameras.cameraN", { n: slot.camera + 1 }),
												})}
											</option>
										)}
									</select>,
								)}
							</div>
						);
					})
				)}
				<button
					type="button"
					className={PANE_BUTTON}
					disabled={!region.slots.some((slot) => slot.rect)}
					onClick={() => void tl.resetLayoutSlotRects(region.id)}
				>
					<RotateCcw size={16} />
					{ts("cameraLayout.resetWindows")}
				</button>
				<button
					type="button"
					className={PANE_BUTTON}
					onClick={() => {
						void tl.removeRegion("cameraLayout", region.id);
						onClose();
					}}
				>
					<Trash2 size={16} style={{ color: "var(--danger)" }} />
					{te("inspector.deleteRegion")}
				</button>
			</div>
		</div>
	);
}
