// Browser regression harness: bundle this entry with Bun and serve it locally.
// It runs the production hook in React, without a generation API or user data.
import { useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCanvasHistory } from "./use-canvas-history";

type Snapshot = { nodes: string[]; connections: string[] };
let editor: { read: () => Snapshot; add: (id: string) => void; undo: () => void; redo: () => void; applying: () => boolean; canRedo: boolean };

function Editor() {
    const [nodes, setNodes] = useState<string[]>([]);
    const [connections, setConnections] = useState<string[]>([]);
    const snapshot = useMemo(() => ({ nodes, connections }), [nodes, connections]);
    const history = useCanvasHistory({
        snapshot, isReady: true,
        applySnapshot: (next) => {
            const applied = { ...next, nodes: next.nodes.map((node) => node) };
            setNodes(applied.nodes);
            setConnections(applied.connections);
            return applied;
        },
        isSameSnapshot: (a, b) => a.nodes === b.nodes && a.connections === b.connections,
    });
    useLayoutEffect(() => {
        editor = {
            read: () => snapshot, add: (id) => setNodes((current) => [...current, id]),
            undo: history.undo, redo: history.redo, applying: () => history.isApplyingRef.current, canRedo: history.canRedo,
        };
    });
    return <pre aria-label="编辑器文档">{JSON.stringify(snapshot)}</pre>;
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 220));
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

async function run() {
    const results: string[] = [];
    try {
        flushSync(() => editor.add("A"));
        await wait();
        flushSync(() => editor.add("B"));
        await wait();
        flushSync(() => editor.undo());
        check(!editor.applying() && editor.read().nodes.join() === "A", "undo did not commit its restored nodes");
        await wait();
        check(editor.canRedo, "normalization created a false edit and cleared redo");
        flushSync(() => editor.redo());
        check(!editor.applying() && editor.read().nodes.join() === "A,B", "redo did not complete");
        results.push("PASS: actual React commit acknowledges normalized undo/redo; redo survives debounce");

        flushSync(() => { editor.undo(); editor.redo(); });
        check(!editor.applying() && editor.read().nodes.join() === "A,B", "batched old application acknowledgement cleared newer state");
        results.push("PASS: consecutive undo/redo in one React batch");

        flushSync(() => { editor.undo(); editor.add("generated-result"); });
        check(!editor.applying() && editor.read().nodes.join() === "A,generated-result", "same-commit result was discarded");
        await wait();
        flushSync(() => editor.undo());
        check(editor.read().nodes.join() === "A", "merged result was not retained in history");
        flushSync(() => editor.redo());
        check(editor.read().nodes.join() === "A,generated-result", "merged result cannot be restored");
        results.push("PASS: asynchronous result merged before acknowledgement is retained and undoable");
        document.getElementById("result")!.textContent = results.join("\n");
    } catch (error) {
        document.getElementById("result")!.textContent = [...results, `FAIL: ${String(error)}`].join("\n");
        console.error(error);
    }
}

const root = document.createElement("div");
const result = document.createElement("pre");
result.id = "result";
result.textContent = "检查中…";
document.body.append(root, result);
flushSync(() => createRoot(root).render(<Editor />));
void run();
