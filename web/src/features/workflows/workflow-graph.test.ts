import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    addWorkflowConnection,
    appendWorkflowOutput,
    createWorkflowNode,
    emptyWorkflowGraph,
    fitWorkflowImage,
    workflowViewportCenter,
    removeWorkflowConnection,
    removeWorkflowNode,
    removeWorkflowOutput,
    setWorkflowOutputCount,
    workflowConnectionKey,
    workflowSourceType,
} from "./workflow-graph";

describe("workflow graph", () => {
    test("allocates stable typed ports and preserves connection order", () => {
        let graph = emptyWorkflowGraph();
        const text = createWorkflowNode("text_input", { x: 20, y: 20 }, "text");
        const image = createWorkflowNode("image_input", { x: 20, y: 180 }, "image");
        const generate = createWorkflowNode("image_generation", { x: 360, y: 80 }, "generate");
        graph = { ...graph, nodes: [text, image, generate] };

        graph = addWorkflowConnection(graph, { sourceNodeId: text.id, sourceSlotId: "output", targetNodeId: generate.id });
        graph = addWorkflowConnection(graph, { sourceNodeId: image.id, sourceSlotId: "output", targetNodeId: generate.id });

        assert.deepEqual(
            graph.connections.map((connection) => connection.order),
            [0, 1],
        );
        assert.deepEqual(
            graph.nodes.find((node) => node.id === generate.id)?.inputPorts?.map((port) => port.type),
            ["text", "image"],
        );
        assert.equal(
            graph.connections.every((connection) => Boolean(connection.targetPortId)),
            true,
        );
    });

    test("rejects cycles, incompatible sources and the tenth input", () => {
        let graph = emptyWorkflowGraph();
        const first = createWorkflowNode("image_generation", { x: 100, y: 100 }, "first");
        const second = createWorkflowNode("image_generation", { x: 440, y: 100 }, "second");
        graph = { ...graph, nodes: [first, second] };
        graph = addWorkflowConnection(graph, { sourceNodeId: first.id, sourceSlotId: first.outputs![0]!.id, targetNodeId: second.id });
        assert.throws(() => addWorkflowConnection(graph, { sourceNodeId: second.id, sourceSlotId: second.outputs![0]!.id, targetNodeId: first.id }), /不能形成循环/);

        const video = createWorkflowNode("video_input", { x: 0, y: 0 }, "video");
        graph = { ...graph, nodes: [...graph.nodes, video] };
        assert.throws(() => addWorkflowConnection(graph, { sourceNodeId: video.id, sourceSlotId: "output", targetNodeId: first.id }), /不支持视频输入/);

        let inputGraph = emptyWorkflowGraph();
        const target = createWorkflowNode("video_generation", { x: 400, y: 0 }, "target");
        const inputs = Array.from({ length: 10 }, (_, index) => createWorkflowNode("text_input", { x: 0, y: index * 80 }, `text-${index}`));
        inputGraph = { ...inputGraph, nodes: [...inputs, target] };
        for (const input of inputs.slice(0, 9)) inputGraph = addWorkflowConnection(inputGraph, { sourceNodeId: input.id, sourceSlotId: "output", targetNodeId: target.id });
        assert.throws(() => addWorkflowConnection(inputGraph, { sourceNodeId: inputs[9]!.id, sourceSlotId: "output", targetNodeId: target.id }), /最多连接 9 个输入/);
    });

    test("keeps existing output slot ids and blocks removal while connected", () => {
        let graph = emptyWorkflowGraph();
        const source = createWorkflowNode("image_generation", { x: 20, y: 20 }, "source");
        const target = createWorkflowNode("video_generation", { x: 500, y: 20 }, "target");
        graph = { ...graph, nodes: [source, target] };
        const firstSlot = source.outputs![0]!.id;
        graph = appendWorkflowOutput(graph, source.id);
        assert.equal(graph.nodes.find((node) => node.id === source.id)?.outputs?.[0]?.id, firstSlot);
        const secondSlot = graph.nodes.find((node) => node.id === source.id)?.outputs?.[1]?.id;
        assert.ok(secondSlot);
        graph = addWorkflowConnection(graph, { sourceNodeId: source.id, sourceSlotId: secondSlot, targetNodeId: target.id });
        assert.throws(() => removeWorkflowOutput(graph, source.id, secondSlot), /输出仍有连线/);
        assert.throws(() => setWorkflowOutputCount(graph, source.id, 1), /输出仍有连线/);
    });

    test("resolves input and generated output media types", () => {
        const image = createWorkflowNode("image_input", { x: 0, y: 0 }, "image");
        const video = createWorkflowNode("video_generation", { x: 0, y: 0 }, "video");
        assert.equal(workflowSourceType(image, "output"), "image");
        assert.equal(workflowSourceType(video, video.outputs![0]!.id), "video");
        assert.equal(workflowSourceType(video, "missing"), undefined);
    });

    test("removes dependent connections and unused input ports", () => {
        let graph = emptyWorkflowGraph();
        const source = createWorkflowNode("text_input", { x: 0, y: 0 }, "source");
        const target = createWorkflowNode("video_generation", { x: 300, y: 0 }, "target");
        graph = { ...graph, nodes: [source, target] };
        graph = addWorkflowConnection(graph, { sourceNodeId: source.id, sourceSlotId: "output", targetNodeId: target.id });
        const connection = graph.connections[0]!;
        graph = removeWorkflowConnection(graph, connection);
        assert.deepEqual(graph.connections, []);
        assert.deepEqual(graph.nodes.find((node) => node.id === target.id)?.inputPorts, []);

        graph = addWorkflowConnection(graph, { sourceNodeId: source.id, sourceSlotId: "output", targetNodeId: target.id });
        graph = removeWorkflowNode(graph, source.id);
        assert.deepEqual(
            graph.nodes.map((node) => node.id),
            [target.id],
        );
        assert.deepEqual(graph.connections, []);
        assert.deepEqual(graph.nodes[0]?.inputPorts, []);
    });

    test("places replacement outputs without overlapping existing cards", () => {
        let graph = emptyWorkflowGraph();
        const source = createWorkflowNode("image_generation", { x: 100, y: 100 }, "source");
        graph = { ...graph, nodes: [source] };
        graph = appendWorkflowOutput(graph, source.id);
        graph = appendWorkflowOutput(graph, source.id);
        const middle = graph.nodes[0]!.outputs![1]!;
        graph = removeWorkflowOutput(graph, source.id, middle.id);
        graph = appendWorkflowOutput(graph, source.id);
        const positions = graph.nodes[0]!.outputs!.map((slot) => `${slot.position?.x}:${slot.position?.y}`);
        assert.equal(new Set(positions).size, positions.length);
    });

    test("identifies equal port ids independently for different target nodes", () => {
        const first = { sourceNodeId: "source-a", sourceSlotId: "output", targetNodeId: "target-a", targetPortId: "input", order: 0 };
        const second = { sourceNodeId: "source-b", sourceSlotId: "output", targetNodeId: "target-b", targetPortId: "input", order: 0 };
        const graph = {
            ...emptyWorkflowGraph(),
            nodes: [
                createWorkflowNode("text_input", { x: 0, y: 0 }, "source-a"),
                createWorkflowNode("text_input", { x: 0, y: 300 }, "source-b"),
                { ...createWorkflowNode("image_generation", { x: 400, y: 0 }, "target-a"), inputPorts: [{ id: "input", type: "text" as const }] },
                { ...createWorkflowNode("image_generation", { x: 400, y: 300 }, "target-b"), inputPorts: [{ id: "input", type: "text" as const }] },
            ],
            connections: [first, second],
        };
        assert.notEqual(workflowConnectionKey(first), workflowConnectionKey(second));
        const next = removeWorkflowConnection(graph, first);
        assert.deepEqual(next.nodes.find((node) => node.id === "target-a")?.inputPorts, []);
        assert.deepEqual(next.nodes.find((node) => node.id === "target-b")?.inputPorts, [{ id: "input", type: "text" }]);
    });
});

describe("workflow image geometry", () => {
    test("fits portrait, landscape and square images using Canvas limits without moving their centers", () => {
        const placeholder = createWorkflowNode("image_input", { x: 30, y: -80 }, "image");
        for (const [width, height, expectedWidth, expectedHeight] of [
            [1200, 1800, (640 * 2) / 3, 640],
            [2000, 1000, 640, 320],
            [1024, 1024, 640, 640],
        ]) {
            const image = fitWorkflowImage(placeholder, { width: width!, height: height! });
            assert.ok(Math.abs(image.width! - expectedWidth!) < 0.001);
            assert.ok(Math.abs(image.height! - expectedHeight!) < 0.001);
            assert.equal(image.position.x + image.width! / 2, 200);
            assert.equal(image.position.y + image.height! / 2, 40);
            assert.equal(fitWorkflowImage(image, { width: width!, height: height! }), image);
        }
    });
    test("preserves custom dimensions on reload and fits replacements only when explicitly requested", () => {
        const custom = { ...createWorkflowNode("image_input", { x: 50, y: 90 }), width: 260, height: 520 };
        assert.equal(fitWorkflowImage(custom, { width: 2000, height: 1000 }), custom);
        const replacement = fitWorkflowImage(custom, { width: 2000, height: 1000 }, true);
        assert.equal(replacement.width, 640);
        assert.equal(replacement.height, 320);
        assert.equal(replacement.position.x + 320, 180);
        assert.equal(replacement.position.y + 160, 350);
        assert.equal(fitWorkflowImage(custom, { width: 0, height: NaN }, true), custom);
        assert.deepEqual(JSON.parse(JSON.stringify(replacement)), replacement);
    });
    test("fits output placeholders without changing slot identity", () => {
        const generation = createWorkflowNode("image_generation", { x: 20, y: 50 });
        const slot = generation.outputs![0]!;
        const fitted = fitWorkflowImage(slot, { width: 1600, height: 900 });
        assert.equal(fitted.id, slot.id);
        assert.equal(fitted.type, "image");
        assert.equal(fitted.width! / fitted.height!, 16 / 9);
    });
    test("new image centers map to the visible viewport after panning and zooming", () => {
        for (const k of [0.5, 1, 1.5]) {
            const viewport = { x: -1230, y: 789, k };
            const size = { width: 1370, height: 750 };
            const center = workflowViewportCenter(viewport, size);
            const image = fitWorkflowImage(createWorkflowNode("image_input", { x: 0, y: 0 }), { width: 1200, height: 1800 });
            const position = { x: center.x - image.width! / 2, y: center.y - image.height! / 2 };
            assert.ok(Math.abs((position.x + image.width! / 2) * k + viewport.x - size.width / 2) < 0.001);
            assert.ok(Math.abs((position.y + image.height! / 2) * k + viewport.y - size.height / 2) < 0.001);
        }
    });
});
