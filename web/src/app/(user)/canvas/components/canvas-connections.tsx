import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

export function getConnectionCurve(from: CanvasNodeData, to: CanvasNodeData) {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);

    return {
        start: { x: startX, y: startY },
        control1: { x: startX + curvature, y: startY },
        control2: { x: endX - curvature, y: endY },
        end: { x: endX, y: endY },
        pathD: `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`,
    };
}

export function ConnectionPath({ connection, from, to, active, pendingCut, onSelect }: { connection: CanvasConnection; from: CanvasNodeData; to: CanvasNodeData; active: boolean; pendingCut?: boolean; onSelect: () => void }) {
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
                    onSelect();
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
}

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
