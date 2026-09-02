import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Workbench } from "@/workbench/browser/workbench";
import { WorkbenchServicesProvider } from "@/workbench/browser/workbench-service-context";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "@/workbench/common/contribution";
import { createLegacyRuntimeContribution } from "@/workbench/contrib/legacy-runtime/browser/legacy-runtime-contribution";
import { createBrowserWorkbenchServices } from "@/workbench/services/browser/browser-workbench-services";
import "./styles/tailwind.css";
import "./webui.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

function reportWorkbenchError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("hhtools renderer failed to initialize", error);

  const element = document.getElementById("boot-error");
  if (!element) return;
  const chinese = document.documentElement.lang === "zh-CN";
  element.style.display = "block";
  element.textContent = chinese
    ? `界面未能初始化：${message}（按 F12 查看 Console）`
    : `The interface could not initialize: ${message} (press F12 for Console)`;
}

// This is the one composition root that knows concrete browser services.
// Each feature declares a narrow contribution here instead of being imported by
// the generic shell. Electron shares this graph and adds host capabilities only
// through its preload boundary rather than through a second renderer bundle.
const services = createBrowserWorkbenchServices();
const contributionLifecycle = new WorkbenchContributionLifecycle(
  services,
  [createLegacyRuntimeContribution(services.legacyRuntimeService)],
  reportWorkbenchError,
);
contributionLifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
createRoot(root).render(
  <WorkbenchServicesProvider
    services={services}
    lifecycle={contributionLifecycle}
  >
    <TooltipProvider>
      <Workbench />
    </TooltipProvider>
  </WorkbenchServicesProvider>,
);
