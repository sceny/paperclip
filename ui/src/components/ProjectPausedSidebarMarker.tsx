import { Pause } from "lucide-react";
import type { PauseReason } from "@paperclipai/shared";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";

export function ProjectPausedSidebarMarker({ pauseReason }: { pauseReason: PauseReason | null | undefined }) {
  if (pauseReason === "budget") return <BudgetSidebarMarker title="Project paused by budget" />;
  if (pauseReason !== "manual") return null;

  const title = "Project paused manually";
  return (
    <span
      title={title}
      aria-label={title}
      className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-(--status-agent-paused) text-foreground shadow-(--shadow-extract-3) dark:text-background"
    >
      <Pause className="h-3 w-3" />
    </span>
  );
}
