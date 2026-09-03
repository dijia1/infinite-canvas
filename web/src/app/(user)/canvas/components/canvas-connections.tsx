import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getConnectionCurve } from "../utils/canvas-connection-geometry";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

export const ConnectionPath = memo(function ConnectionPath({ connection, from, to, active, pendingCut, onSelect }: { connection: CanvasConnection; from: CanvasNodeData; to: CanvasNodeData; active: boolean; pendingCut?: boolean; onSelect: (connectionId: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { pathD } = getConnectionCurve(from, to);
    const highlight = pendingCut || active;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect(connection.id);
                }}
            />
            <path
                d={pathD}
                stroke={highlight ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={pendingCut ? 4 : active ? 3 : 2}
                strokeOpacity={highlight ? 1 : 0.82}
                fill="none"
                strokeDasharray={pendingCut ? "9 6" : undefined}
                style={{ filter: highlight ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
        </g>
    );
});

export function ActiveConnectionPath({ node, handle, mouseWorld }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const distance = Math.abs(endX - startX);
    const pathD = `M ${startX} ${startY} C ${startX + distance * 0.5} ${startY}, ${endX - distance * 0.5} ${endY}, ${endX} ${endY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
import { memo } from "react";
