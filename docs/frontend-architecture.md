# Frontend Architecture

## Goal

Keep one small React renderer for both WebUI and Electron GUI. Organize code by
user-facing feature, with explicit dependencies and no legacy runtime bridge.
Visual implementation follows [Frontend Visual Design](./frontend-design.md).

## Structure

```text
src/
├── main.tsx                 # React bootstrap only
├── App.tsx                  # Composition and small shared state
├── navigation.ts            # Shared view identities and sidebar data
├── components/
│   ├── Navbar.tsx           # Five-item application menu shell
│   ├── Sidebar.tsx          # Fixed seven-item feature navigation
│   ├── Inspector.tsx        # Shared fixed right-side page frame
│   ├── ImportDropzone.tsx   # Shared visual import surface
│   ├── SearchField.tsx      # Shared compact search control
│   ├── SegmentedControl.tsx # Shared three-way local selector
│   ├── WorkflowSteps.tsx    # Shared pipeline and disclosure structure
│   ├── Field.tsx            # Shared compact form field
│   ├── RobotPicker.tsx      # Shared robot selection shell
│   ├── RetargetControls.tsx # Shared retarget settings shell
│   └── ui/                  # Project-owned shadcn primitives
├── features/                # One folder per product feature
│   ├── motion/
│   │   ├── MotionView.tsx   # Motion inspector and local presentation state
│   │   └── api.ts           # Motion Library/upload/job transport
│   ├── robot/
│   │   ├── RobotView.tsx    # Robot import and library view
│   │   └── api.ts           # Robot catalog/selection transport
│   ├── h2r/
│   │   ├── HumanToRobotView.tsx
│   │   └── api.ts           # Calibration, H2R job and export transport
│   ├── r2r/
│   │   ├── RobotToRobotView.tsx
│   │   └── api.ts           # Source trajectory, R2R job and export transport
│   ├── batch/
│   │   └── BatchView.tsx    # Local V2M/H2R/R2R shells
│   ├── video-to-motion/
│   │   └── VideoToMotionView.tsx
│   └── analysis/
│       ├── AnalysisView.tsx # Dataset analysis view and local presentation state
│       └── api.ts           # Dataset scan, analysis jobs, subset and exports
├── stage/                   # R3F Stage surface and floating view controls
│   ├── StageCanvas.tsx      # One Canvas, camera, controls, lights and grid
│   ├── StageEmpty.tsx       # Legacy initial empty-state copy
│   ├── StagePlaybackBar.tsx # Play, pause, seek and single-frame controls
│   ├── playback.ts          # Shared renderer playback cursor and timing
│   ├── SkeletonLayer.tsx    # Animated source skeleton layer
│   ├── CapsuleBodyLayer.tsx # Universal tube-and-joint body fallback
│   ├── capsuleBody.ts       # Capsule geometry and frame updates
│   ├── BodyMeshLayer.tsx    # Animated baked-body lifecycle
│   ├── bodyMesh.ts          # Gzip decode and dynamic body geometry
│   ├── EnvironmentLayer.tsx # Terrain and animated interaction objects
│   ├── RobotLayer.tsx       # GLB/fallback robot and trajectory playback
│   ├── types.ts             # Stage renderer data contracts
│   └── StageViewMenu.tsx    # React visibility HUD
└── styles.css
```

Directories and files are created only when their first real user exists.

## Dependencies

```text
main -> App -> features -> components/ui
             |\
             +-> stage       # typed payloads only
             +-> lib/api     # shared HTTP/error/job mechanics
```

- `main.tsx` only mounts `App`.
- `App.tsx` composes views; it does not implement workflows.
- `App.tsx` owns shared inputs and completed workflow results, then projects the
  active workflow onto the single Stage.
- A feature owns its view and local state.
- Features do not reach into another feature's view or state. An explicit
  cross-feature handoff may reuse an exported, side-effect-free transport API
  (for example, Analysis uses Motion's library loader for Stage preview).
- `stage/` and shared components never import from features.
- Browser code never imports Python, Node, or Electron directly.

### Stage renderer

- `StageCanvas.tsx` owns the single R3F `<Canvas>` and its local orbit control.
- The scene keeps the legacy camera, transparent renderer, lights, grid, axes,
  and Z-up world transform; overlays stay ordinary React siblings.
- `@react-three/drei` is intentionally not installed. Direct Three addon imports
  keep the first renderer slice small and explicit.
- Motion, terrain, baked body, and robot payloads will arrive through typed
  React-owned state. Layer components must not call FastAPI or read `window`.

## Growth Rules

- Start a feature with one view file. Split out `api.ts` or `model.ts` only when
  that responsibility becomes independently useful or testable.
- Keep endpoint calls inside the owning feature; add a shared API primitive only
  after a second real feature needs it.
- Extract shared code after a second real caller appears.
- Keep server state authoritative; use React state for presentation state.
- Keep H2R and R2R mounted while hidden so an in-flight server job and its
  local form state survive navigation; only the active workflow owns Stage.
- Add shadcn components individually. Do not prebuild a component library.
- Keep only tokens and document-wide defaults in `styles.css`; colocate feature
  and component styling with their JSX using Tailwind utilities.
- Do not add a router, global store, event bus, DI container, command registry,
  or plugin lifecycle without a concrete requirement.
- Comments explain contracts and reasons, not obvious JSX.

## Current Progress

- [x] Empty shared React renderer
- [x] Five-item top menu and dropdown shells
- [x] Fixed seven-item left navigation
- [x] Minimal shadcn foundation and floating Stage view menu
- [x] Motion inspector visual shell
- [x] Robot inspector visual shell
- [x] Video-to-Motion inspector visual shell
- [x] Human-to-Robot inspector visual shell
- [x] Robot-to-Robot inspector visual shell
- [x] Batch inspector visual shell
- [x] Data Analysis inspector visual shell
- [x] R3F Stage base scene (camera, controls, lights, axes, grid)
- [x] Shared R3F timeline with play/pause, seek, and frame stepping
- [x] Animated skeleton, baked body, terrain, and interaction-object layers
- [x] Legacy-compatible capsule body when a baked skin is unavailable
- [x] Motion Library list, upload, job polling, and Stage handoff
- [x] Robot catalog, zero-pose selection, GLB parsing, and Stage handoff
- [x] Six curated robot presets installed from pinned upstream sources
- [x] Human-to-Robot calibration, retarget job, playback, and export
- [x] Robot-to-Robot upload/library source, calibration, retarget, and export
- [x] Animated H2R/R2R robot trajectories and scaled scene layers
- [x] Dataset scan, folder upload, cached analysis, and progress polling
- [x] Analysis metrics, tags, embedding scatter, histograms, and filters
- [x] Analysis subset recommendation, manifest/robot export, and human preview

Analysis keeps the server as the source of truth: the view starts and polls the
`dataset_analyze` job, renders the returned manifest, and sends subset/export
requests back to the existing FastAPI dataset routes. Human result rows hand a
typed motion payload to the shared Stage; robot rows remain available through
the Robot-to-Robot workflow until the Stage gains a dataset-scene token layer.

The baked-body renderer is covered by the backend-compatible gzip/vertex test.
SMPL-family parameter clips (AMASS, GVHMR, Motion-X, and PHUMA) now remain
loadable without licensed weights through a NumPy kinematic proxy; the Stage
shows the animated skeleton and marks the body mesh unavailable. Installing
the licensed SMPL/SMPL-H/SMPL-X files enables exact joints and the real surface.

Robot selection remains server-authoritative. The six curated models are
installed into the user Robot Library with `scripts/install_builtin_robots.py`;
large model files and their upstream licenses are not copied into Git.

## References

- [VS Code source organization](https://github.com/microsoft/vscode/wiki/source-code-organization)
- [Grafana navigation patterns](https://grafana.com/developers/saga/patterns/navigation/)
- [React state structure](https://react.dev/learn/choosing-the-state-structure)
- [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite)
- [shadcn Toggle Group](https://ui.shadcn.com/docs/components/radix/toggle-group)
