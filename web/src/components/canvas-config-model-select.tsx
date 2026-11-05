"use client";

import { CanvasSettingsSelect } from "@/components/canvas-settings-select";

export function CanvasConfigModelSelect({ value, options, onChange }: { value: string | undefined; options: Array<{ id: string; name: string }> | undefined; onChange: (value: string) => void }) {
    if (!options?.length) return null;
    return (
        <div className="canvas-config-model min-w-0 w-full" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <CanvasSettingsSelect className="!min-w-0 !w-full" size="small" value={value} options={options.map((item) => ({ value: item.id, label: item.name }))} onChange={onChange} />
        </div>
    );
}
