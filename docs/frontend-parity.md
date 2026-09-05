# Frontend Parity

This checklist compares the React renderer with `hhtools/web/frontend-old`.
The old frontend defines behavior and Stage semantics; the current visual design
may improve spacing, rounded corners, accessibility, and narrow-screen layout.

| Area | Current state | Required parity work |
| --- | --- | --- |
| Stage / Three.js | Mostly complete | Correct HUD family colors, availability, labels, and calibration projection |
| Motion | Functional | Restore the compact validation summary |
| Robot | Functional | Restore import/load validation summary |
| Video to Motion | Functional when GVHMR is ready | Add a real server-side running-job cancellation protocol |
| Human to Robot | Functional | Restore richer input validation |
| Robot to Robot | Functional | Restore richer input validation |
| Batch | Functional | Run full solver smoke when the licensed/runtime dependencies are available |
| Analysis | Complete | Scatter preview, stable filtering, histogram brushing, and removable upload basket are connected |
| Application menu | Complete | Typed navigation, imports, current export, settings, help, theme, and desktop exit are connected |

## Order

- [x] Match the Stage visibility HUD state and asset-family colors.
- [x] Share one complete React calibration editor between H2R and R2R.
- [x] Restore Canvas joint selection, constrained dragging, and synchronized calibration HUD controls.
- [x] Implement the three Batch pipelines against the existing FastAPI routes.
  - [x] Add the shared typed import, scan, job, progress, and download boundary.
  - [x] Refresh calibration on re-entry and feed completed V2M clips into the H2R draft.
- [ ] Restore H2R scaled preview and omitted result/export controls.
  - [x] Load the calibrated scaled skeleton/scene before Retarget without forcing it visible.
  - [x] Show shared diagnostics and complete FPS/time/header export controls for H2R/R2R.
  - [x] Restore persisted Source, Target, Result, and Overlay Stage presets.
- [ ] Restore remaining Motion, Robot, V2M, Analysis, and application-menu actions.
  - [x] Share one persistent H2R Batch draft with Motion and remove managed folders safely.
  - [x] Preserve the complete registered V2M Motion payload for Stage and H2R.
  - [x] Preserve the last successful Motion while a replacement video is pending or invalid.
  - [x] Keep V2M and Batch mounted while their jobs or drafts are inactive.
  - [x] Preview selected videos and import existing GVHMR `.pt` results.
  - [x] Restore Analysis scatter selection/preview, fixed coordinates, histogram brushing, and upload-basket removal.
  - [x] Connect the desktop Exit command through the trusted Electron IPC boundary.
  - [x] Connect all five application menus without global DOM commands.
  - [x] Refresh R2R robot and trajectory catalogs whenever the workspace is entered.
- [ ] Run route-contract tests and desktop/narrow-screen browser smoke for every pipeline.

## Rules

- FastAPI remains the source of truth for assets, calibration, jobs, and exports.
- Feature views own their transport and workflow state.
- Shared components own reusable presentation and pure interaction rules only.
- Stage consumes typed data; it never starts jobs or calls feature endpoints.
- No compatibility runtime, global DOM lookup, hidden fallback, or duplicate state model.
