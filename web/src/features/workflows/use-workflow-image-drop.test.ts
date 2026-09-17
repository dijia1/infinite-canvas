import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, sourceModule } from "@/test-utils/source-component";
import * as drop from "./workflow-image-drop";
import * as files from "@/app/(user)/canvas/utils/canvas-file-drop";
import * as adapter from "./workflow-canvas-adapter";
import type { useWorkflowImageDrop } from "./use-workflow-image-drop";
import type { WorkflowGraph } from "./types";

for (const end of ["complete", "readonly", "unmount"] as const) {
    test(`drop lifecycle ${end}: stale upload never changes another editing session`, async () => {
        const h = hookHarness();
        let complete!: (value: { mediaId: string }) => void;
        const upload = new Promise<{ mediaId: string }>(r => { complete = r; });
        let uploaded!: () => void;
        const started = new Promise<void>(r => { uploaded = r; });
        let graph: WorkflowGraph = { version: 1, nodes: [], connections: [] };
        let commits = 0, selects = 0, revoked = 0;
        const { useWorkflowImageDrop: useHook } = sourceModule<{ useWorkflowImageDrop: typeof useWorkflowImageDrop }>(new URL("./use-workflow-image-drop.ts", import.meta.url), {
            react: h.hooks,
            "@/app/(user)/canvas/utils/canvas-file-drop": files,
            "@/lib/image-utils": { readImageMeta: async () => ({ width: 800, height: 400 }) },
            "@/services/api/image": { uploadUserImage: async (_file: File, intent: string) => { assert.equal(intent, "canvas"); uploaded(); return upload; } },
            "./workflow-canvas-adapter": adapter,
            "./workflow-image-drop": drop,
        }, { URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => revoked++ } });
        const options = { readOnly: false, setGraph: (update: any) => { commits++; graph = update(graph); }, onSelected: () => selects++, notify() {} };
        const hook = h.render(() => useHook(options));
        const pending = hook.importFiles([new File(["image"], "test.png", { type: "image/png" })], { x: 200, y: 300 });
        await started;
        graph = { ...graph, nodes: [{ id: "text", type: "text_input", text: "new edit", position: { x: 0, y: 0 } }] };
        if (end === "readonly") h.render(() => useHook({ ...options, readOnly: true }));
        if (end === "unmount") h.unmount();
        complete({ mediaId: "uploaded" });
        await pending;
        assert.equal(graph.nodes[0]!.text, "new edit");
        assert.equal(commits, end === "complete" ? 1 : 0);
        assert.equal(selects, end === "complete" ? 1 : 0);
        assert.equal(graph.nodes.length, end === "complete" ? 2 : 1);
        assert.equal(revoked, 1);
        if (end !== "unmount") h.unmount();
        assert.equal(h.postUnmountUpdates, 0);
    });
}
