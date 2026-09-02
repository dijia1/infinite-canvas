export function createCanvasCanonicalRestore<Value>() {
    let generation = 0;
    return {
        run: async (hydrate: () => Promise<Value>, apply: (value: Value) => void) => {
            const current = ++generation;
            const value = await hydrate();
            if (current !== generation) return false;
            apply(value);
            return true;
        },
        invalidate: () => {
            generation += 1;
        },
    };
}
