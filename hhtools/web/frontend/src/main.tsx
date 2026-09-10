import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RuntimeApp } from "./features/runtime/RuntimeApp";
import "./styles.css";

const root = document.getElementById("app-root");
if (!root) throw new Error("Missing #app-root mount point");

createRoot(root).render(
  <StrictMode>
    {document.querySelector('meta[name="hhtools-runtime"]')?.getAttribute("content") === "1" ? <RuntimeApp /> : <App />}
  </StrictMode>,
);
