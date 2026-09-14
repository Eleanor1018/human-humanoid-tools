import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { StreamClient } from "./features/runtime/StreamClient";
import "./styles.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

createRoot(root).render(
  <StrictMode>
    {window.location.pathname === "/stream" ? <StreamClient /> : <App />}
  </StrictMode>,
);
