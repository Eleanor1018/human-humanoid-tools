import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";

import {
  getRobotLibrary,
  loadRobot,
  type RobotPayload,
  type RobotSummary,
} from "./api";

/** Keep curated models in the same visual order as the previous inspector. */
const CURATED_ORDER: Readonly<Record<string, number>> = {
  g1_29dof: 0,
  roboto_origin: 1,
  agibot_x2_ultra: 2,
  asimov_1: 3,
  fourier_gr2: 4,
  berkeley_humanoid_lite: 5,
};

const CURATED_LABELS: Readonly<Record<string, string>> = {
  g1_29dof: "Unitree G1",
  roboto_origin: "ROBOTO_ORIGIN (RPO)",
  agibot_x2_ultra: "AgiBot X2",
  asimov_1: "Asimov 1",
  fourier_gr2: "Fourier GR-2",
  berkeley_humanoid_lite: "Berkeley Humanoid Lite",
};

const CURATED_ICONS: Readonly<Record<string, string>> = {
  g1_29dof: "/robot-icons/unitree-g1.webp",
  roboto_origin: "/robot-icons/roboto-origin.webp",
  agibot_x2_ultra: "/robot-icons/agibot-x2.webp",
  asimov_1: "/robot-icons/asimov-1.webp",
  fourier_gr2: "/robot-icons/fourier-gr2.webp",
  berkeley_humanoid_lite: "/robot-icons/berkeley-humanoid-lite.webp",
};

const FALLBACK_ICON = "/hhtools-robot.svg";
const CURATED_NAMES = Object.keys(CURATED_LABELS);

function mapValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function robotLabel(robot: RobotSummary): string {
  return mapValue(CURATED_LABELS, robot.name) ?? (robot.display_name || robot.name);
}

function sortRobots(left: RobotSummary, right: RobotSummary): number {
  const leftOrder = mapValue(CURATED_ORDER, left.name);
  const rightOrder = mapValue(CURATED_ORDER, right.name);
  if (leftOrder !== undefined || rightOrder !== undefined) {
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    return leftOrder - rightOrder;
  }
  return robotLabel(left).localeCompare(robotLabel(right));
}

function robotIcon(name: string): string {
  return mapValue(CURATED_ICONS, name) ?? FALLBACK_ICON;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RobotView({
  currentRobot,
  onRobotLoaded,
}: {
  /** App-owned stable input; failed replacements leave it untouched. */
  currentRobot?: RobotPayload | null;
  /** App uses this to publish the server payload to the shared Stage. */
  onRobotLoaded?: (payload: RobotPayload | null) => void;
}) {
  const [robots, setRobots] = useState<RobotSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [libraryDir, setLibraryDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const robotRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    libraryRequest.current?.abort();
    const request = new AbortController();
    libraryRequest.current = request;
    setLoadingLibrary(true);
    setError(null);
    void getRobotLibrary({ signal: request.signal })
      .then((response) => {
        if (request.signal.aborted) return;
        setRobots([...response.robots]);
        setLibraryDir(response.library_dir || null);
      })
      .catch((reason: unknown) => {
        if (request.signal.aborted) return;
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (!request.signal.aborted) setLoadingLibrary(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      libraryRequest.current?.abort();
      robotRequest.current?.abort();
    };
  }, [refresh]);

  const filteredRobots = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...robots]
      .sort(sortRobots)
      .filter((robot) => {
        const haystack = [
          robot.name,
          robotLabel(robot),
          robot.display_name,
          String(robot.num_dof),
          robot.builtin ? "built-in builtin 内置" : "imported custom 导入",
        ]
          .join(" ")
          .toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      });
  }, [robots, search]);

  const loadedName = currentRobot?.name ?? null;
  const loadedRobot = loadedName
    ? robots.find((robot) => robot.name === loadedName)
    : undefined;

  const load = useCallback(
    (robot: RobotSummary) => {
      if (!robot.has_urdf || loadingName) return;
      robotRequest.current?.abort();
      const request = new AbortController();
      robotRequest.current = request;
      setLoadingName(robot.name);
      setError(null);
      void loadRobot(robot.name, { signal: request.signal })
        .then((payload) => {
          if (request.signal.aborted) return;
          onRobotLoaded?.(payload);
        })
        .catch((reason: unknown) => {
          if (request.signal.aborted) return;
          setError(errorMessage(reason));
        })
        .finally(() => {
          if (!request.signal.aborted) setLoadingName(null);
        });
    },
    [loadingName, onRobotLoaded],
  );

  return (
    <InspectorPage title="Robot">
      <div className="flex shrink-0 flex-col gap-2.5">
        <ImportDropzone
          label="URDF import area"
          icon="/icons/robot/file.svg"
          title="1 · URDF file"
          className="min-h-[120px] px-9 py-3.5"
        >
          <Button size="sm" disabled>
            Choose .urdf
          </Button>
        </ImportDropzone>
        <ImportDropzone
          label="Robot mesh import area"
          icon="/icons/robot/folder.svg"
          title="2 · Mesh folder"
          className="min-h-[120px] px-9 py-3.5"
        >
          <Button size="sm" disabled>
            Choose mesh folder
          </Button>
        </ImportDropzone>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loadedRobot ? `Loaded: ${robotLabel(loadedRobot)}` : "No URDF selected."}
        </p>
      </div>

      <section
        className="flex min-h-[220px] flex-1 flex-col gap-2"
        aria-labelledby="robot-library-title"
      >
        <div className="flex items-center justify-between gap-2">
          <h2
            id="robot-library-title"
            className="text-[19px] leading-tight font-bold tracking-normal text-foreground"
          >
            Robot Library
          </h2>
          <Button size="sm" onClick={refresh} disabled={loadingLibrary || Boolean(loadingName)}>
            {loadingLibrary ? "Loading..." : "Refresh"}
          </Button>
        </div>
        <SearchField
          label="Search the Robot Library"
          placeholder="Search robots..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={loadingLibrary}
        />
        {error && (
          <p className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed text-[#8c2929] break-words" role="alert">
            {error}
          </p>
        )}
        <div
          className="min-h-[138px] flex-1 overflow-y-auto rounded-md border border-border-subtle bg-surface p-1"
          aria-live="polite"
          aria-busy={loadingLibrary || Boolean(loadingName)}
        >
          {loadingLibrary ? (
            <p className="p-2 text-xs text-muted-foreground">Loading robots...</p>
          ) : !robots.length ? (
            <div className="grid gap-1 p-2 text-xs text-muted-foreground">
              <p>No robot models are available.</p>
              <p className="break-words text-[11px] leading-relaxed">
                Add a URDF and its meshes to {libraryDir || "the robot library"}, then refresh.
              </p>
              <p className="break-words text-[11px] leading-relaxed">
                Curated presets: {CURATED_NAMES.map((name) => CURATED_LABELS[name]).join(", ")}.
              </p>
            </div>
          ) : !filteredRobots.length ? (
            <p className="p-2 text-xs text-muted-foreground">
              No robots match “{search}”.
            </p>
          ) : (
            <ul className="grid gap-0.5" aria-label="Robot models">
              {filteredRobots.map((robot) => {
                const active = loadedName === robot.name;
                const busy = loadingName === robot.name;
                const unavailable = !robot.has_urdf;
                return (
                  <li key={robot.name} className="min-w-0 list-none">
                    <button
                      type="button"
                      className="grid min-h-12 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left text-foreground transition-colors hover:border-border-subtle hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-[active=true]:border-primary data-[active=true]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      data-active={active}
                      aria-current={active ? "true" : undefined}
                      aria-label={`Load robot ${robotLabel(robot)}`}
                      disabled={unavailable || Boolean(loadingName)}
                      onClick={() => load(robot)}
                    >
                      <img
                        className="size-8 rounded-sm object-cover"
                        src={robotIcon(robot.name)}
                        alt=""
                        aria-hidden="true"
                        onError={(event) => {
                          const image = event.currentTarget;
                          if (image.src.endsWith(FALLBACK_ICON)) return;
                          image.src = FALLBACK_ICON;
                        }}
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <strong className="truncate text-[13px] font-semibold">
                          {robotLabel(robot)}
                        </strong>
                        <small className="truncate text-[11px] text-muted-foreground">
                          {robot.num_dof} DoF · {robot.builtin ? "Built-in" : "Imported"}
                          {unavailable ? " · URDF missing" : ""}
                        </small>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {busy
                          ? "Loading..."
                          : active
                            ? "Loaded"
                            : unavailable
                              ? "Unavailable"
                              : "Load"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </InspectorPage>
  );
}
