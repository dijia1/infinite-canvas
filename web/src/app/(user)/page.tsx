import { redirect } from "next/navigation";

import { appPath } from "@/lib/app-path";

export default function IndexPage() {
    redirect(appPath("/canvas"));
}
