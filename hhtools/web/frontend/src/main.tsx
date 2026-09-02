import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Workbench } from "@/workbench/browser/workbench";
import { WorkbenchServicesProvider } from "@/workbench/browser/workbench-service-context";
import { createBrowserWorkbenchServices } from "@/workbench/services/browser/browser-workbench-services";
import "./styles/tailwind.css";
import "./webui.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

// This is the one composition root that knows concrete browser services.
// Feature state stays inside Workbench, and DOM-dependent legacy startup still
// happens after React commits. Electron shares this graph and adds capabilities
// through its preload boundary rather than through a second renderer bundle.
const services = createBrowserWorkbenchServices();
createRoot(root).render(
  <WorkbenchServicesProvider services={services}>
    <TooltipProvider>
      <Workbench />
    </TooltipProvider>
  </WorkbenchServicesProvider>,
);
