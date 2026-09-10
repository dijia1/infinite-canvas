import assert from "node:assert/strict";
import test from "node:test";
import { MutationObserver, QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import type * as React from "react";

import { apiRequestError } from "@/services/api/request";
import type { AppRole, PortalMember } from "@/services/api/members";
import { deferred, elements, flushAsync, hookHarness, oneElement, sourceModule } from "@/test-utils/source-component";

const pageURL = new URL("./page.tsx", import.meta.url);

function member(userUid: string, appRole: AppRole = "admin"): PortalMember {
    return { userUid, appRole, displayName: userUid, roles: ["staff"], enabled: true, syncedAt: "2026-09-10T00:00:00Z" };
}

function membersPage() {
    let currentHooks!: ReturnType<typeof hookHarness>["hooks"];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    const cache = { items: [member("self"), member("other / user")], total: 2 };
    queryClient.setQueryData(["portal-members"], cache);
    queryClient.setQueryData(["portal-session"], { id: "self", appRole: "admin" });
    const cacheWrites: unknown[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") cacheWrites.push(event.query.queryKey);
    });
    const invalidations: unknown[][] = [];
    const sessionGate = deferred<void>();
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = async (filters, options) => {
        invalidations.push([...(filters?.queryKey || [])]);
        if (filters?.queryKey?.[0] === "portal-session") await sessionGate.promise;
        await invalidate(filters, options);
    };
    const successes: string[] = [];
    const errors: string[] = [];
    const requests: Array<{ uid: string; role: AppRole; result: ReturnType<typeof deferred<PortalMember>> }> = [];
    const mutations: Promise<unknown>[] = [];
    let clears = 0;
    const store = { user: { id: "self" }, clearSession: () => { clears += 1; } };
    const module = sourceModule<{ default: () => React.ReactNode }>(pageURL, {
        react: {
            useState: (initial: unknown) => currentHooks.useState(initial),
            useDeferredValue: (value: unknown) => value,
        },
        "@tanstack/react-query": {
            useQueryClient: () => queryClient,
            useQuery: () => ({ data: cache, isLoading: false, isError: false }),
            // React Query itself executes the production mutationFn/onSuccess/onError
            // and owns pending state. Only the React subscription is driven manually.
            useMutation: (options: MutationObserverOptions<any, unknown, any>) => {
                const ref = currentHooks.useRef<MutationObserver<any, unknown, any> | null>(null);
                if (!ref.current) ref.current = new MutationObserver(queryClient, options);
                else ref.current.setOptions(options);
                const observer = ref.current;
                return { ...observer.getCurrentResult(), mutate: (value: unknown) => {
                    const mutation = observer.mutate(value);
                    mutations.push(mutation);
                    void mutation.catch(() => undefined);
                } };
            },
        },
        antd: {
            App: { useApp: () => ({ message: { success: (text: string) => successes.push(text), error: (text: string) => errors.push(text) } }) },
            Button: "Button", Empty: "Empty", Input: { Search: "Search" }, Pagination: "Pagination", Select: "Select", Spin: "Spin", Tag: "Tag",
        },
        "@ant-design/icons": { ReloadOutlined: "ReloadOutlined" },
        "next/link": { default: "Link" },
        "@/lib/app-path": { appPath: (path: string) => `/canvas${path}` },
        "@/services/api/request": { apiRequestError },
        "@/services/api/members": {
            fetchPortalMembers: async () => cache,
            updatePortalMemberAppRole: (uid: string, role: AppRole) => {
                const result = deferred<PortalMember>();
                requests.push({ uid, role, result });
                return result.promise;
            },
        },
        "@/services/api/operation-logs": { syncPortalMembers: async () => ({ count: 2 }) },
        "@/stores/use-admin-store": { useAdminStore: (selector: (value: typeof store) => unknown) => selector(store) },
    });
    const pageHarness = hookHarness();
    const tree = pageHarness.render(() => { currentHooks = pageHarness.hooks; return module.default(); });
    const rows = elements(tree, (element) => typeof element.type === "function" && !!element.props.member).map((element) => {
        const harness = hookHarness();
        const component = element.type as React.FunctionComponent<any>;
        const render = () => harness.render(() => { currentHooks = harness.hooks; return component(element.props); });
        return { uid: element.props.member.userUid as string, render, unmount: () => harness.unmount() };
    });
    assert.equal(rows.length, 2, "the page must render both actual MemberRow components");
    return {
        rows, requests, mutations, queryClient, cache, cacheWrites, invalidations, successes, errors, sessionGate,
        get clears() { return clears; },
        close() { rows.forEach((row) => row.unmount()); pageHarness.unmount(); unsubscribe(); queryClient.clear(); },
    };
}

test("member role selectors are independent of encoded operation-history links and send the selected role", async (t) => {
    const page = membersPage();
    t.after(() => page.close());
    const row = page.rows[1];
    const tree = row.render();
    const select = oneElement(tree, "Select");
    const link = oneElement(tree, "Link");
    assert.equal(link.props.href, "/canvas/admin/operations?actor=other%20%2F%20user");
    assert.equal(elements(link, (element) => element.type === "Select").length, 0);
    assert.deepEqual(select.props.options.map((option: { value: string }) => option.value), ["member", "public_assets_manager", "admin"]);
    select.props.onChange("public_assets_manager");
    await flushAsync();
    assert.equal(page.requests[0].uid, row.uid);
    assert.equal(page.requests[0].role, "public_assets_manager");
    page.requests[0].result.resolve(member(row.uid, "public_assets_manager"));
    await page.mutations[0];
    assert.deepEqual(page.invalidations, [["portal-members"]]);
    assert.deepEqual(page.successes, ["应用角色已更新"]);
    assert.equal(page.clears, 0);
});

test("each row remains pending only for its own mutation and other rows can update independently", async (t) => {
    const page = membersPage();
    t.after(() => page.close());
    const [self, other] = page.rows;
    oneElement(other.render(), "Select").props.onChange("member");
    await flushAsync();
    assert.equal(oneElement(other.render(), "Select").props.disabled, true);
    assert.equal(oneElement(self.render(), "Select").props.disabled, false);
    oneElement(self.render(), "Select").props.onChange("admin");
    await flushAsync();
    assert.deepEqual(page.queryClient.getMutationCache().getAll().map((mutation) => mutation.options.mutationKey), [
        ["portal-member-app-role", other.uid], ["portal-member-app-role", self.uid],
    ]);
    page.requests[0].result.resolve(member(other.uid, "member"));
    await page.mutations[0];
    assert.equal(oneElement(other.render(), "Select").props.disabled, false);
    assert.equal(oneElement(self.render(), "Select").props.disabled, true);
    page.requests[1].result.resolve(member(self.uid, "admin"));
    await page.mutations[1];
    assert.equal(oneElement(self.render(), "Select").props.disabled, false);
    assert.equal(page.clears, 0, "a response retaining the admin role must not revoke the current session");
});

for (const role of ["member", "public_assets_manager"] as const) {
    test(`a ${role} PATCH response for the signed-in admin awaits session invalidation before clearing access`, async (t) => {
        const page = membersPage();
        t.after(() => page.close());
        const self = page.rows[0];
        // The server response is authoritative, even if it differs from the requested role.
        oneElement(self.render(), "Select").props.onChange("admin");
        await flushAsync();
        page.requests[0].result.resolve(member("self", role));
        let completed = false;
        void page.mutations[0].then(() => { completed = true; });
        await flushAsync();
        assert.deepEqual(page.invalidations, [["portal-session"]]);
        assert.equal(page.clears, 0, "clearSession must wait for session invalidation");
        assert.equal(completed, false, "MemberRow must await its parent revocation callback");
        assert.equal(oneElement(self.render(), "Select").props.disabled, true);
        assert.deepEqual(page.successes, []);
        assert.deepEqual(page.cacheWrites, []);
        page.sessionGate.resolve();
        await page.mutations[0];
        assert.equal(page.clears, 1);
        assert.equal(page.queryClient.getQueryState(["portal-session"])?.isInvalidated, true);
        assert.equal(oneElement(self.render(), "Select").props.disabled, false);
        assert.equal(page.queryClient.getQueryData(["portal-members"]), page.cache);
        assert.deepEqual(page.cacheWrites, []);
        assert.deepEqual(page.invalidations, [["portal-session"]]);
        assert.deepEqual(page.successes, []);
    });
}

test("role failures display the backend error and preserve cached members and the current session", async (t) => {
    const page = membersPage();
    t.after(() => page.close());
    const self = page.rows[0];
    oneElement(self.render(), "Select").props.onChange("member");
    await flushAsync();
    const failure = { isAxiosError: true, response: { status: 403, data: { msg: "不能移除最后一位管理员" } } };
    page.requests[0].result.reject(failure);
    await assert.rejects(page.mutations[0], (error) => error === failure);
    assert.deepEqual(page.errors, ["不能移除最后一位管理员"]);
    assert.deepEqual(page.successes, []);
    assert.deepEqual(page.invalidations, []);
    assert.deepEqual(page.cacheWrites, []);
    assert.equal(page.queryClient.getQueryData(["portal-members"]), page.cache);
    assert.equal(page.clears, 0);
    assert.equal(oneElement(self.render(), "Select").props.disabled, false);
});

test("role failures without a backend message use the application fallback", async (t) => {
    const page = membersPage();
    t.after(() => page.close());
    oneElement(page.rows[1].render(), "Select").props.onChange("member");
    await flushAsync();
    page.requests[0].result.reject({});
    await assert.rejects(page.mutations[0]);
    assert.deepEqual(page.errors, ["应用角色更新失败"]);
    assert.deepEqual(page.cacheWrites, []);
});
