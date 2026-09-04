import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

createRoot(root).render(
  <StrictMode>
    <main
      id="app"
      className="min-h-screen"
      data-hhtools-ready="true"
      aria-label="Human-Humanoid Tools"
    />
  </StrictMode>,
);
