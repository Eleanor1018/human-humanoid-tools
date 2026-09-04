import { useState } from "react";

import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";
import { VideoToMotionPage } from "./video-to-motion/VideoToMotionPage";

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");

  return (
    <div
      id="app"
      className="grid h-dvh min-h-0 min-w-0 grid-cols-[208px_minmax(0,1fr)] grid-rows-[40px_minmax(0,1fr)]"
      data-hhtools-ready="true"
      data-active-view={activeView}
    >
      <Navbar />
      <Sidebar activeView={activeView} onSelect={setActiveView} />
      {activeView === "video-to-motion" ? <VideoToMotionPage /> : <Stage />}
    </div>
  );
}
