# Changelog

All notable changes to this project will be documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Resident Runtime shared by the GUI, CLI, Python SDK and MCP, with durable jobs,
  scoped authentication, resumable file transfers and supervised worker processes.
- One HHTools business GUI, available directly or through whole-application WebRTC
  streaming with keyboard, pointer and file-transfer controls.
- Runtime workflow commands: `hhtools h2r`, `r2r`, `analysis`, and `video2motion`,
  including ordered H2R/R2R batches, preflight and verified artifact downloads.
- `hhtools jobs` for job listing, inspection, waiting, cancellation, retry and
  artifact discovery; `hhtools runs` for local receipt discovery and recovery.
- Analysis `select`, `compare` and durable `export` commands.
- MCP local file/bundle upload and artifact download under configured transfer
  roots, plus workflow readiness/defaults discovery and bounded image inspection.
- Initial project scaffold: `pyproject.toml`, Apache-2.0 `LICENSE`, README (bilingual), contribution
  guidelines, GitHub Actions CI, and the `hhtools` Python package skeleton.
- Core data model: `Hierarchy`, `Skeleton`, `Motion`, `AnimationBuffer`, and a vectorised math
  layer (quaternion, rotation, transform, vector utilities) in `hhtools.core`.
- Unified internal NPZ schema at `hhtools.io.npz` together with a self-written Apache-2.0 BVH
  parser and exporter at `hhtools.io.bvh`.
- `hhtools convert` CLI entry point for headless BVH/GLB to NPZ batch conversion.
- Minimal Viser + FastAPI viewer (`hhtools ui`) that loads an NPZ and draws a playable skeleton.

### Changed

- Workflow execution no longer requires `run`. Existing `convert run`, `import run`,
  `retarget run` and `retarget interaction-mesh run` invocations remain compatible.
- Interactive workflow commands show summaries and progress; pipes retain JSON
  output. `--json`, `--human` and `--quiet` select the presentation explicitly.
- Recovery receipts are written before uploading and retain transfer, plan, job
  and download progress. Version-1 submission receipts remain readable.
- MCP lists fewer duplicate tools by default while preserving callable aliases;
  generated tools publish output schemas and scope metadata.
- H2R/R2R results retain full solved trajectories for later export without rerunning IK.

### Fixed

- Revoking a GUI operator token also closes its stream and delegated browser credential.
- Failed/cancelled streaming attempts release sessions; HTTP/ICE waits have deadlines,
  and failed worker RPCs cannot reuse out-of-order replies.
- Runtime downloads preserve existing and concurrently created destination files by
  default, with explicit overwrite and artifact-bound resumption.
- Workflow argument and parameter-file errors are checked before network/upload work;
  positional files may be interleaved with options.
- Parameter diagnostics retain field locations; interrupted response reads retain
  structured errors and known upload recovery IDs.
