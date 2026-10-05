import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import shell from "../NewEditorShell.module.css";
import styles from "./EditorShellV4.module.css";

export function paneHeader(
	icon: ReactNode,
	title: string,
	onClose: () => void,
	closeLabel: string,
) {
	return (
		<header
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "14px 16px 12px",
				borderBottom: "1px solid var(--border-soft)",
				// Le corps défile sous l'en-tête : sans ça, l'en-tête se comprime avec lui.
				flexShrink: 0,
			}}
		>
			<span style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>{icon}</span>
			<h2
				style={{
					margin: 0,
					flex: 1,
					fontSize: 14,
					fontWeight: 600,
					color: "var(--fg-emphasis)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h2>
			<button
				type="button"
				className={styles.iconBtn}
				title={closeLabel}
				aria-label={closeLabel}
				onClick={onClose}
				style={{
					width: 30,
					height: 30,
				}}
			>
				<X size={16} />
			</button>
		</header>
	);
}

export function paneRow(label: string, control: ReactNode) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

/** Un libellé au-dessus de son contrôle, pour ceux qui prennent toute la largeur du panneau
 *  (une `ChoiceRow`) : à côté d'un libellé, ils n'auraient plus la place de montrer leurs choix.
 *  `value` nomme le choix courant quand les boutons ne font que le dessiner. */
export function paneStack(label: string, control: ReactNode, value?: string) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
				{label}
				{value ? <span className={shell.sectionLabelValue}>{value}</span> : null}
			</span>
			{control}
		</div>
	);
}

/** Every action of the selection pane, delete included: the red icon says it destroys; a red
 *  slab outshouted every setting above it. */
export const PANE_BUTTON = `${shell.btn} ${shell.btnSecondary}`;

// Le panneau découpe son contenu (coins arrondis + flou), donc un corps sans ascenseur perd
// silencieusement ce qui dépasse — c'est ce qui arrivait au pane d'annotation, le plus haut de
// tous, dès qu'on réduisait la fenêtre. L'en-tête reste fixe, le corps défile, comme les
// panneaux de facette (cf. `.paneBody` de NewEditorShell).
export const PANE_BODY_STYLE: CSSProperties = {
	padding: "16px",
	display: "flex",
	flexDirection: "column",
	gap: 16,
	flex: "1 1 auto",
	minHeight: 0,
	overflowY: "auto",
	overflowX: "hidden",
	overscrollBehavior: "contain",
	scrollbarWidth: "thin",
	scrollbarColor: "var(--border) transparent",
};
