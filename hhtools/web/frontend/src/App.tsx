import { useState } from "react";

import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");

  return (
    <div
      id="app"
      className="workspace-shell"
      data-hhtools-ready="true"
      data-active-view={activeView}
    >
      <Navbar />
      <Sidebar activeView={activeView} onSelect={setActiveView} />
      <Stage />
    </div>
  );
}
