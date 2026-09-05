# Frontend Parity

This checklist compares the React renderer with `hhtools/web/frontend-old`.
The old frontend defines behavior and Stage semantics; the current visual design
may improve spacing, rounded corners, accessibility, and narrow-screen layout.

| Area | Current state | Required parity work |
| --- | --- | --- |
| Stage / Three.js | Mostly complete | Correct HUD family colors, availability, labels, and calibration projection |
| Motion | Functional | Restore validation summary, Batch basket handoff, and linked-folder removal |
| Robot | Functional | Restore import/load validation summary |
| Video to Motion | Functional when GVHMR is ready | Restore existing-result import and explicit running-job cancellation |
| Human to Robot | Functional | Restore scaled preview, full calibration editor, validation/evaluation, and complete export options |
| Robot to Robot | Functional | Restore full calibration editor, validation/evaluation, and complete export options |
| Batch | Visual shell only | Implement V2M, H2R, and R2R input queues, jobs, progress, failures, and downloads |
| Analysis | Functional | Restore scatter-point preview and removable multi-folder upload basket |
| Application menu | Visual shell only | Wire navigation, import commands, current export, settings, help, and desktop exit |

## Order

- [x] Match the Stage visibility HUD state and asset-family colors.
- [x] Share one complete React calibration editor between H2R and R2R.
- [ ] Implement the three Batch pipelines against the existing FastAPI routes.
  - [x] Add the shared typed import, scan, job, progress, and download boundary.
- [ ] Restore H2R scaled preview and omitted result/export controls.
- [ ] Restore remaining Motion, Robot, V2M, Analysis, and application-menu actions.
  - [x] Preserve the complete registered V2M Motion payload for Stage and H2R.
  - [x] Preserve the last successful Motion while a replacement video is pending or invalid.
- [ ] Run route-contract tests and desktop/narrow-screen browser smoke for every pipeline.

## Rules

- FastAPI remains the source of truth for assets, calibration, jobs, and exports.
- Feature views own their transport and workflow state.
- Shared components own reusable presentation and pure interaction rules only.
- Stage consumes typed data; it never starts jobs or calls feature endpoints.
- No compatibility runtime, global DOM lookup, hidden fallback, or duplicate state model.
