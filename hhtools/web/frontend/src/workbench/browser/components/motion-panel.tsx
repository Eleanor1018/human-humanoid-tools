import { useState } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import { useWindowEvent } from "@/hooks/use-window-event";
import type { MotionLibrarySettingsSnapshot } from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { SearchField } from "./search-field";

type MotionUploadProfile = "mimic" | "intermimic" | "meshmimic";

const profiles: Array<{
  id: MotionUploadProfile;
  glyph: string;
  en: string;
  zh: string;
}> = [
  {
    id: "mimic",
    glyph: "🎞",
    en: "Drop a motion file or folder",
    zh: "拖入动作文件或文件夹",
  },
  {
    id: "intermimic",
    glyph: "📦",
    en: "Drop an object-interaction motion folder",
    zh: "拖入物体交互动作文件夹",
  },
  {
    id: "meshmimic",
    glyph: "⛰",
    en: "Drop a terrain-motion folder",
    zh: "拖入地形动作文件夹",
  },
];

export function MotionPanel({
  active,
  locale,
  settings,
  settingsBusy,
  onChooseLibrary,
}: {
  active: boolean;
  locale: WorkspaceLocale;
  settings: MotionLibrarySettingsSnapshot | null;
  settingsBusy: boolean;
  onChooseLibrary(): void;
}) {
  const text = useLocaleText(locale);
  const [profile, setProfile] = useState<MotionUploadProfile>("mimic");
  const [search, setSearch] = useState("");
  const [info, setInfo] = useState(false);
  const selected = profiles.find((item) => item.id === profile) ?? profiles[0];

  // Menu/command-palette imports always use the generic mimic picker. Keeping
  // that intent as an event avoids reaching into this component's local state.
  useWindowEvent("hhtools:motion-profile-request", (event) => {
    setProfile(event.detail);
    setInfo(false);
  });

  return (
    <section className={`panel${active ? " active" : ""}`} data-panel="motion">
      <h2>{text("Motion", "动作")}</h2>
      <div className="motion-import-control" id="tour-motion-import">
        <div
          className="motion-profile-switcher"
          role="radiogroup"
          aria-label={text("Motion import type", "动作上传类型")}
        >
          {profiles.map((item) => (
            <label key={item.id} className="motion-profile-selector">
              <input
                className="sr-only"
                type="radio"
                name="motion-upload-profile"
                value={item.id}
                checked={profile === item.id}
                onChange={() => {
                  setProfile(item.id);
                  setInfo(false);
                }}
              />
              <span className="motion-profile-selector-content">{item.id}</span>
            </label>
          ))}
        </div>
        <div
          className="dropzone motion-upload-shared"
          id="motion-drop-shared"
          data-profile={profile}
          role="group"
          aria-label={`${profile} import area`}
        >
          <div className="motion-import-info">
            <button
              type="button"
              className="motion-import-info-trigger"
              aria-label={text("View import instructions", "查看上传说明")}
              aria-controls="motion-upload-info"
              aria-expanded={info}
              onClick={() => setInfo((current) => !current)}
            >
              ?
            </button>
            {info && (
              <div
                id="motion-upload-info"
                className="motion-import-info-popover"
                role="tooltip"
              >
                <strong>{profile}</strong>
                <span>
                  {text(
                    "Choose a complete file or dataset folder. The runtime validates the selected profile.",
                    "请选择完整文件或数据集目录；运行时会按所选类型进行校验。",
                  )}
                </span>
              </div>
            )}
          </div>
          <div className="dz-glyph">{selected.glyph}</div>
          <div className="dz-title">{text(selected.en, selected.zh)}</div>
          <div className="row" style={{ marginTop: 10 }}>
            {profile === "mimic" && (
              <button
                id="motion-pick-file"
                type="button"
                className="btn secondary small"
                data-pick={profile}
                data-accept=".bvh,.glb,.gltf,.npz,.npy,.pkl,.pt"
              >
                {text("Choose file", "选择文件")}
              </button>
            )}
            <button
              id="motion-pick-folder"
              type="button"
              className="btn secondary small"
              data-pick={profile}
              data-folder="1"
            >
              {text("Choose folder", "选择文件夹")}
            </button>
          </div>
        </div>
      </div>
      <section
        className="motion-library"
        id="tour-motion-library"
        aria-labelledby="motion-library-title"
      >
        <h2 id="motion-library-title">{text("Library", "资源库")}</h2>
        <span id="motion-assets-hint" hidden />
        <div className="motion-library-root-row">
          <button
            type="button"
            className="btn secondary small motion-library-root-button"
            disabled={settingsBusy || settings?.editable === false}
            title={settings?.root}
            onClick={onChooseLibrary}
          >
            {settingsBusy
              ? text("Switching…", "正在切换…")
              : text("Choose library directory", "选择资源库目录")}
          </button>
          <div className="motion-library-category-select-wrap">
            <select
              className="search motion-library-category-select"
              id="lib-category"
              aria-label={text(
                "Filter the library by motion type",
                "按动作类型筛选资源库",
              )}
            >
              <option value="all">{text("All", "全部")}</option>
              <option value="motion">{text("Motion", "纯动作")}</option>
              <option value="object">
                {text("Object interaction", "物体交互")}
              </option>
              <option value="terrain">
                {text("Terrain scene", "地形场景")}
              </option>
            </select>
          </div>
        </div>
        <div className="motion-library-tools">
          <SearchField
            value={search}
            onValueChange={setSearch}
            id="lib-search"
            label={text("Search the Motion Library", "搜索资源库动作")}
            placeholder={text("Search motions…", "搜索动作……")}
            clearLabel={text("Clear library search", "清除资源库搜索")}
          />
          <button
            type="button"
            className="btn secondary small"
            id="lib-link-path"
          >
            {text("Link directory", "链接目录")}
          </button>
        </div>
        <div className="motion-library-list-frame">
          <div className="lib-list" id="lib-list" />
        </div>
      </section>
      <div className="card" id="motion-meta-card" style={{ display: "none" }}>
        <h3 id="motion-name">—</h3>
        <div id="motion-meta" />
        <div
          className="validation-summary"
          id="motion-validation-summary"
          aria-live="polite"
        />
        <div className="divider" />
        <button className="btn secondary small" id="add-to-basket">
          {text("＋ Add to batch basket", "＋ 加入批量篮子")}
        </button>
      </div>
    </section>
  );
}
