import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import ts from "typescript";

// Evaluate the complete production module with test-local imports. Unlike module
// mocks, each invocation owns its module state and cannot affect another test.
export function sourceModule<T>(url: URL, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
    const code = ts.transpileModule(readFileSync(url, "utf8"), {
        fileName: url.pathname,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    const module = { exports: {} };
    const require = (name: string) => {
        assert.ok(Object.hasOwn(imports, name), `unexpected production import: ${name}`);
        return imports[name];
    };
    new Function("require", "module", "exports", "React", ...Object.keys(globals), code)(require, module, module.exports, React, ...Object.values(globals));
    return module.exports as T;
}

type Effect = { dependencies?: readonly unknown[]; cleanup?: () => void };

// A deterministic hook driver, not a React renderer: it preserves state/ref
// slots, compares effect dependencies and runs cleanup before replacement effects.
// Tests explicitly attach refs before effects and flush after asynchronous work.
export function hookHarness() {
    const slots: unknown[] = [];
    const effects: Effect[] = [];
    let cursor = 0;
    let dirty = false;
    let mounted = true;
    let postUnmountUpdates = 0;
    let pending: Array<{ index: number; setup: () => void | (() => void); dependencies?: readonly unknown[] }> = [];
    const hooks = {
        useState<T>(initial?: T | (() => T)) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
            return [slots[index] as T, (update: T | ((previous: T) => T)) => {
                if (!mounted) {
                    postUnmountUpdates += 1;
                    return;
                }
                const next = typeof update === "function" ? (update as (previous: T) => T)(slots[index] as T) : update;
                if (!Object.is(next, slots[index])) {
                    slots[index] = next;
                    dirty = true;
                }
            }] as const;
        },
        useRef<T>(initial: T) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = { current: initial };
            return slots[index] as { current: T };
        },
        useMemo<T>(create: () => T, dependencies?: readonly unknown[]) {
            const index = cursor++;
            const previous = slots[index] as { value: T; dependencies?: readonly unknown[] } | undefined;
            if (!previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length || dependencies.some((value, i) => !Object.is(value, previous.dependencies![i]))) {
                slots[index] = { value: create(), dependencies };
            }
            return (slots[index] as { value: T }).value;
        },
        useEffect(setup: () => void | (() => void), dependencies?: readonly unknown[]) {
            const index = cursor++;
            const previous = effects[index];
            if (!previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length || dependencies.some((value, i) => !Object.is(value, previous.dependencies![i]))) {
                pending.push({ index, setup, dependencies });
            }
        },
    };
    return {
        hooks,
        render<T>(render: () => T, beforeEffects?: (result: T) => void): T {
            assert.ok(mounted, "cannot render an unmounted hook");
            let result: T;
            let renders = 0;
            do {
                assert.ok(++renders < 25, "hook did not settle");
                cursor = 0;
                dirty = false;
                pending = [];
                result = render();
                beforeEffects?.(result);
                for (const effect of pending) effects[effect.index]?.cleanup?.();
                for (const effect of pending) {
                    effects[effect.index] = { dependencies: effect.dependencies, cleanup: effect.setup() || undefined };
                }
            } while (dirty);
            return result;
        },
        unmount() {
            if (!mounted) return;
            mounted = false;
            for (const effect of effects) effect?.cleanup?.();
        },
        get postUnmountUpdates() { return postUnmountUpdates; },
    };
}

// Inspect the actual JSX tree without rendering Ant Design or touching the DOM.
// Popover content is deliberately included so tests reach its wired child picker.
export type TestElement = React.ReactElement<Record<string, any>>;
export function elements(tree: unknown, predicate: (element: TestElement) => boolean): TestElement[] {
    if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
    if (!React.isValidElement<Record<string, any>>(tree)) return [];
    return [
        ...(predicate(tree) ? [tree] : []),
        ...elements(tree.props.children, predicate),
        ...elements(tree.props.content, predicate),
    ];
}

export function oneElement(tree: unknown, type: unknown): TestElement {
    const matches = elements(tree, (element) => element.type === type);
    assert.equal(matches.length, 1, `expected one ${String(type)} element`);
    return matches[0];
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

// Drain promise continuations and React Query notifications without wall-clock sleeps.
export async function flushAsync() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}
