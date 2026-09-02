import { useState } from "react";

import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { SearchField } from "./search-field";

export function RobotAssetsPanel({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [search, setSearch] = useState("");
  const [info, setInfo] = useState<"urdf" | "mesh" | null>(null);
  const zone = (kind: "urdf" | "mesh") => {
    const urdf = kind === "urdf";
    return (
      <div
        className="dropzone robot-import-dropzone"
        id={urdf ? "robot-drop-urdf" : "robot-drop-mesh"}
        role="group"
      >
        <div className="motion-import-info">
          <button
            type="button"
            className="motion-import-info-trigger"
            aria-expanded={info === kind}
            onClick={() =>
              setInfo((current) => (current === kind ? null : kind))
            }
          >
            ?
          </button>
          {info === kind && (
            <div
              id={urdf ? "robot-urdf-info" : "robot-mesh-info"}
              className="motion-import-info-popover"
              role="tooltip"
            >
              <strong>
                {text(
                  urdf ? "URDF description" : "Robot mesh assets",
                  urdf ? "URDF 描述文件" : "机器人 Mesh 资源",
                )}
              </strong>
              <span>
                {text(
                  urdf
                    ? "Choose the robot description before its mesh folder."
                    : "Choose the folder referenced by the URDF.",
                  urdf
                    ? "请先选择机器人描述文件，再添加 Mesh 文件夹。"
                    : "请选择 URDF 引用的 Mesh 文件夹。",
                )}
              </span>
            </div>
          )}
        </div>
        <div className="dz-glyph" aria-hidden="true">
          {urdf ? "📄" : "📁"}
        </div>
        <div className="dz-title">
          {text(
            urdf ? "1 · URDF file" : "2 · Mesh folder",
            urdf ? "1 · URDF 文件" : "2 · Mesh 文件夹",
          )}
        </div>
        <div className="row robot-import-actions">
          <button
            className="btn secondary small"
            id={urdf ? "robot-pick-urdf" : "robot-pick-mesh-folder"}
          >
            {text(
              urdf ? "Choose .urdf" : "Choose mesh folder",
              urdf ? "选择 .urdf" : "选择 mesh 文件夹",
            )}
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="panel-stack robot-assets-stack">
      <h2>{text("Robot", "机器人")}</h2>
      <div className="robot-import-stack" id="tour-robot-import">
        {zone("urdf")}
        {zone("mesh")}
      </div>
      <p
        className="hint robot-import-status"
        id="robot-import-status"
        aria-live="polite"
      >
        {text("No URDF selected.", "尚未选择 URDF。")}
      </p>
      <section
        className="motion-library robot-library"
        aria-labelledby="robot-library-title"
      >
        <h2 id="robot-library-title">{text("Robot Library", "机器人库")}</h2>
        <div className="robot-library-tools">
          <SearchField
            value={search}
            onValueChange={setSearch}
            id="robot-library-search"
            label={text("Search the Robot Library", "搜索机器人库")}
            placeholder={text("Search robots…", "搜索机器人……")}
            clearLabel={text("Clear robot search", "清除机器人搜索")}
          />
        </div>
        <div className="motion-library-list-frame robot-library-list-frame">
          <div
            className="lib-list robot-library-list"
            id="robot-library-list"
          />
        </div>
        <p className="hint robot-library-hint" id="robot-library-hint" />
      </section>
      <div className="card" id="robot-meta-card" style={{ display: "none" }}>
        <h3 id="robot-name">—</h3>
        <div id="robot-meta" />
        <div
          className="validation-summary"
          id="robot-validation-summary"
          aria-live="polite"
        />
      </div>
    </div>
  );
}
