"use client";

import { useRouter } from "next/navigation";
import { Button } from "antd";
import { Plus } from "lucide-react";

import { appPath } from "@/lib/app-path";
import { CanvasDeleteProjectsDialog } from "./components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "./components/canvas-project-card";
import { CanvasBootstrapFeedback } from "./components/canvas-sync-feedback";
import { useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasUiStore } from "./stores/use-canvas-ui-store";

export default function CanvasPage() {
    const router = useRouter();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const readyForCanvasMutations = useCanvasStore((state) => state.readyForCanvasMutations);
    const ready = hydrated && readyForCanvasMutations;
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => {
        router.push(appPath(`/canvas/${id}`));
    };
    const createAndEnter = () => enterProject(createProject(`无限画布 ${projects.length + 1}`));
    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">画布库</p>
                        <h1 className="mt-3 text-3xl font-semibold">无限画布</h1>
                        <div className="mt-2">
                            <CanvasBootstrapFeedback />
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {projects.length ? (
                            <Button disabled={!ready} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!ready} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>

                {!ready ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{hydrated ? "正在同步画布..." : "正在加载画布..."}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
