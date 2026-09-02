import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { createCanvasImageHydrationPlan } from "./canvas-client-page";
import { hydrateCanvasImages } from "@/services/canvas-image-hydration";

const publicImage = (id: string, x: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: "Public image",
    position: { x, y: 0 },
    width: 100,
    height: 100,
    metadata: { publicImageId: `public-${id}` },
});

test("page hydration sends public-image-only nodes through initial and lazy recovery", async () => {
    const near = publicImage("near", 0);
    const far = publicImage("far", 6000);

    const plan = createCanvasImageHydrationPlan([near, far], { x: 0, y: 0, k: 1 }, { width: 1200, height: 720 });

    assert.deepEqual(
        plan.initialNodes.map((node) => node.id),
        ["near"],
    );
    assert.deepEqual([...plan.pendingImageIds], ["far"]);

    const recovered = await Promise.all(
        [plan.initialNodes, [far]].map((nodes) =>
            hydrateCanvasImages(nodes, {
                resolveMediaUrl: async () => "",
                readCachedImage: async () => "",
                resolveRemoteImage: async () => {
                    throw new Error("public images must use public access");
                },
                fetchPublicImageAccess: async (publicImageId) => ({ url: `https://public.example/${publicImageId}`, mediaId: `media-${publicImageId}` }),
                loadMediaImage: async (mediaId, remoteURL) => ({ url: await remoteURL(), storageKey: `media:${mediaId}`, mediaId, width: 100, height: 100, bytes: 1, mimeType: "image/png" }),
                uploadImage: async () => {
                    throw new Error("public images must not upload during recovery");
                },
            }),
        ),
    );

    assert.deepEqual(
        recovered.flat().map((node) => node.metadata?.mediaId),
        ["media-public-near", "media-public-far"],
    );
});
