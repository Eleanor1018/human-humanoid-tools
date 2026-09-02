import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Workbench } from "@/workbench/browser/workbench";
import "./styles/tailwind.css";
import "./webui.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

createRoot(root).render(
  <TooltipProvider>
    <Workbench />
  </TooltipProvider>,
);
