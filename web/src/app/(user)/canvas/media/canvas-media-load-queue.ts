export type CanvasMediaLoadPriority = "interactive" | "visible-original" | "visible-thumbnail" | "prefetch";

type QueueRequest<Value> = {
    key: string;
    priority: CanvasMediaLoadPriority;
    signal?: AbortSignal;
    load: (signal: AbortSignal) => Promise<Value>;
};

export type MediaLoadLease<Value> = {
    promise: Promise<Value>;
    release: () => void;
};

type Consumer<Value> = {
    released: boolean;
    resolve: (value: Value) => void;
    reject: (reason: unknown) => void;
    removeAbortListener?: () => void;
};

type QueueItem<Value> = {
    key: string;
    priority: number;
    order: number;
    load: (signal: AbortSignal) => Promise<Value>;
    controller: AbortController;
    consumers: Set<Consumer<Value>>;
    started: boolean;
};

const priorityWeight: Record<CanvasMediaLoadPriority, number> = {
    interactive: 4,
    "visible-original": 3,
    "visible-thumbnail": 2,
    prefetch: 1,
};

function abortError() {
    return Object.assign(new Error("图片加载已取消"), { name: "AbortError" });
}

export type CanvasMediaLoadQueue = {
    request<Value>(request: QueueRequest<Value>): MediaLoadLease<Value>;
};

export function createCanvasMediaLoadQueue({ concurrency = 4 }: { concurrency?: number } = {}): CanvasMediaLoadQueue {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("图片加载并发数必须大于零");

    const items = new Map<string, QueueItem<unknown>>();
    const pending: QueueItem<unknown>[] = [];
    let running = 0;
    let order = 0;

    const activeConsumers = <Value>(item: QueueItem<Value>) => [...item.consumers].filter((consumer) => !consumer.released);

    const removePending = <Value>(item: QueueItem<Value>) => {
        const index = pending.indexOf(item as unknown as QueueItem<unknown>);
        if (index >= 0) pending.splice(index, 1);
    };

    const finish = <Value>(item: QueueItem<Value>, result: { value: Value } | { error: unknown }) => {
        if (items.get(item.key) === item) items.delete(item.key);
        activeConsumers(item).forEach((consumer) => {
            consumer.removeAbortListener?.();
            if ("value" in result) consumer.resolve(result.value);
            else consumer.reject(result.error);
        });
        item.consumers.clear();
    };

    const nextPending = () => {
        pending.sort((left, right) => right.priority - left.priority || left.order - right.order);
        return pending.shift();
    };

    const pump = () => {
        while (running < concurrency) {
            const item = nextPending();
            if (!item) return;
            if (!activeConsumers(item).length) {
                if (items.get(item.key) === item) items.delete(item.key);
                continue;
            }
            item.started = true;
            running += 1;
            void Promise.resolve()
                .then(() => item.load(item.controller.signal))
                .then((value) => finish(item, { value }))
                .catch((error) => finish(item, { error }))
                .finally(() => {
                    running -= 1;
                    pump();
                });
        }
    };

    const releaseConsumer = <Value>(item: QueueItem<Value>, consumer: Consumer<Value>) => {
        if (consumer.released) return;
        consumer.released = true;
        consumer.removeAbortListener?.();
        consumer.reject(abortError());

        if (activeConsumers(item).length) return;
        if (!item.started) {
            removePending(item);
            if (items.get(item.key) === item) items.delete(item.key);
            return;
        }
        item.controller.abort();
    };

    return {
        request<Value>({ key, priority, signal, load }: QueueRequest<Value>): MediaLoadLease<Value> {
            let item = items.get(key) as QueueItem<Value> | undefined;
            if (!item) {
                item = {
                    key,
                    priority: priorityWeight[priority],
                    order: order++,
                    load,
                    controller: new AbortController(),
                    consumers: new Set(),
                    started: false,
                };
                items.set(key, item as QueueItem<unknown>);
                pending.push(item as QueueItem<unknown>);
            } else {
                item.priority = Math.max(item.priority, priorityWeight[priority]);
            }

            let resolve!: (value: Value) => void;
            let reject!: (reason: unknown) => void;
            const promise = new Promise<Value>((nextResolve, nextReject) => {
                resolve = nextResolve;
                reject = nextReject;
            });
            const consumer: Consumer<Value> = { released: false, resolve, reject };
            item.consumers.add(consumer);
            if (signal) {
                const onAbort = () => releaseConsumer(item!, consumer);
                signal.addEventListener("abort", onAbort, { once: true });
                consumer.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
                if (signal.aborted) onAbort();
            }
            pump();
            return { promise, release: () => releaseConsumer(item!, consumer) };
        },
    };
}
