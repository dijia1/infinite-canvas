import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeImageRequestOptions, schemaOptionString } from "./image-request-schema";

const schema = {
    version: "v1",
    maxReferenceImages: 10,
    supportsMask: false,
    fields: [
        { key: "resolution", label: "尺寸", type: "select" as const, required: false, default: "1k", options: [{ value: "1k", label: "1K" }, { value: "1.5k", label: "1.5K" }] },
        { key: "watermark", label: "水印", type: "boolean" as const, required: false, default: true },
    ],
};

describe("image request schema", () => {
    test("uses provider defaults and discards stale options after a provider switch", () => {
		assert.deepEqual(normalizeImageRequestOptions(schema, { resolution: "1.5k", watermark: false, quality: "high" }), { resolution: "1.5k", watermark: false });
		assert.deepEqual(normalizeImageRequestOptions(schema, { resolution: "4k", quality: "high" }), { resolution: "1k", watermark: true });
    });

    test("reads selectable option values safely", () => {
		assert.equal(schemaOptionString({ resolution: "1.5k" }, "resolution"), "1.5k");
		assert.equal(schemaOptionString({ watermark: false }, "watermark"), "");
    });
});
