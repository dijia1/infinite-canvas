export type CanvasCanonicalIdentity = {
    projectId: string;
    generation: number;
};

type CanvasCanonicalToken = CanvasCanonicalIdentity & { epoch: number };

function sameIdentity(left: CanvasCanonicalIdentity | null, right: CanvasCanonicalIdentity | null) {
    return Boolean(left && right && left.projectId === right.projectId && left.generation === right.generation);
}

export function createCanvasCanonicalRestore() {
    let epoch = 0;
    let active: CanvasCanonicalIdentity | null = null;

    const capture = (identity: CanvasCanonicalIdentity): CanvasCanonicalToken => ({ ...identity, epoch });
    const isCurrent = (token: CanvasCanonicalToken, readIdentity: () => CanvasCanonicalIdentity | null) => token.epoch === epoch && sameIdentity(token, active) && sameIdentity(token, readIdentity());
    const applyIfCurrent = (token: CanvasCanonicalToken, readIdentity: () => CanvasCanonicalIdentity | null, apply: () => void) => {
        if (!isCurrent(token, readIdentity)) return false;
        apply();
        return true;
    };

    return {
        run: async <Value,>(identity: CanvasCanonicalIdentity, hydrate: () => Promise<Value>, apply: (value: Value) => void, readIdentity: () => CanvasCanonicalIdentity | null) => {
            epoch += 1;
            active = identity;
            const token = capture(identity);
            const value = await hydrate();
            return applyIfCurrent(token, readIdentity, () => apply(value));
        },
        runCurrent: async <Value,>(identity: CanvasCanonicalIdentity, hydrate: () => Promise<Value>, apply: (value: Value, token: CanvasCanonicalToken) => void, readIdentity: () => CanvasCanonicalIdentity | null) => {
            const token = capture(identity);
            if (!isCurrent(token, readIdentity)) return false;
            const value = await hydrate();
            return applyIfCurrent(token, readIdentity, () => apply(value, token));
        },
        capture,
        isCurrent,
        applyIfCurrent,
        invalidate: () => {
            epoch += 1;
            active = null;
        },
    };
}
