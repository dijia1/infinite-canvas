import { redirect } from "next/navigation";

// Legacy bookmarks return to the single Portal entry; the app has no login flow.
export default function AdminLoginPage() {
    redirect("/");
}
