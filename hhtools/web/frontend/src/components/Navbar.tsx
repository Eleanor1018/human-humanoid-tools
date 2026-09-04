import { useState } from "react";

const menuItems = ["File", "Workflows", "Analysis", "Settings", "Help"] as const;
type MenuItem = (typeof menuItems)[number];

export function Navbar() {
  const [activeMenu, setActiveMenu] = useState<MenuItem | null>(null);

  return (
    <header id="topbar">
      <div className="logo" aria-label="HHTOOLS">
        <img className="desktop-logo-mark" src="/hhtools-robot.svg" alt="" />
        <span className="desktop-brand-name">HHTOOLS</span>
      </div>

      <nav className="desktop-menubar" aria-label="Application menu">
        {menuItems.map((item) => (
          <div key={item} className="desktop-menu-root">
            <button
              type="button"
              className={`desktop-menu-trigger${activeMenu === item ? " active" : ""}`}
              aria-pressed={activeMenu === item}
              onClick={() =>
                setActiveMenu((current) => (current === item ? null : item))
              }
            >
              {item}
            </button>
          </div>
        ))}
      </nav>
      <div className="spacer" />
    </header>
  );
}
