import { Navbar } from "./components/Navbar";

export function App() {
  return (
    <div id="app" className="workspace-shell" data-hhtools-ready="true">
      <Navbar />
      <main className="app-content" />
    </div>
  );
}
