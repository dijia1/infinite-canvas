// One-time transition only. Normal deployments use check-gateway-health.mjs.
import { pathToFileURL } from "node:url";
export const LEGACY_SHA = "731a00ad08b90a10403df974d78c433e3e6db887";
export const HEALTH_URL = "https://www.semetaloa.com/apps/infinite-canvas/api/healthz";
export async function checkLegacyHealth(url, revision, {fetch=globalThis.fetch,timeoutMs=6000}={}) {
    if(url!==HEALTH_URL || revision!==LEGACY_SHA) throw new Error("Legacy verification is restricted to the fixed Canvas baseline.");
    const response=await fetch(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
    if(response.status!==200 || !/^text\/plain(?:;|$)/i.test(response.headers.get("content-type")??"")) throw new Error("Legacy health contract failed.");
    const reader=response.body?.getReader();
    if(!reader)throw new Error("Legacy response missing.");
    let body="",bytes=0;
    const decoder=new TextDecoder();
    try {
        while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256)throw new Error("Legacy response too large.");body+=decoder.decode(value,{stream:true});}
        body+=decoder.decode();
    } finally { await reader.cancel().catch(()=>{}); }
    if(body!=="ok")throw new Error("Legacy response did not confirm the old database-ping contract.");
}
if(process.argv[1]==="-" || process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    checkLegacyHealth(process.argv[2],process.argv[3]).catch(()=>{console.error("Fixed legacy Canvas health verification failed.");process.exitCode=1;});
}
