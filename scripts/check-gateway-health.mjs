import { pathToFileURL } from "node:url";

export async function checkHealth(value, { gateway = true, fetch = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const url = new URL(value);
  const expectedPath = gateway ? "/apps/infinite-canvas/api/healthz" : "/api/healthz";
  if (url.pathname !== expectedPath || url.search || url.hash || url.username || url.password
    || (gateway ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))) {
    throw new Error("健康检查地址无效。");
  }
  const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error("健康接口未返回 HTTP 200 JSON。");
  }
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error("健康接口未确认依赖可用。");
}

if (process.argv[1] === "-" || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 3005}/api/healthz`;
  checkHealth(url, { gateway: true }).catch(() => {
    console.error("健康检查失败，请检查应用、数据库和网关状态。");
    process.exitCode = 1;
  });
}
