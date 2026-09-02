import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Workbench } from "@/workbench/browser/workbench";
import "./styles/tailwind.css";
import "./webui.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

// Keep the entry point deliberately small: host detection, service startup,
// routing, and feature state all belong to the workbench composition root.
// Electron loads this same bundle; its extra capabilities arrive via preload.
createRoot(root).render(
  <TooltipProvider>
    <Workbench />
  </TooltipProvider>,
);
