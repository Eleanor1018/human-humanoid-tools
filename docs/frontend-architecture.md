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
│   └── ui/                  # Project-owned shadcn primitives
├── features/                # One folder per product feature
│   ├── motion/
│   ├── robot/
│   ├── h2r/
│   ├── r2r/
│   ├── batch/
│   ├── video2motion/
│   └── analysis/
├── stage/                   # Stage surface and floating view controls
├── api.ts                   # Shared HTTP primitives only
├── host.ts                  # Web/Electron boundary only
└── styles.css
```

Directories and files are created only when their first real user exists.

## Dependencies

```text
main -> App -> features -> api -> FastAPI
             |
             +-> stage -> Three.js
             +-> components/ui
```

- `main.tsx` only mounts `App`.
- `App.tsx` composes views; it does not implement workflows.
- A feature owns its view, endpoint calls, and local state.
- Features do not reach into another feature's internal files.
- `api.ts`, `host.ts`, and `stage/` never import from features.
- Browser code never imports Python, Node, or Electron directly.

## Growth Rules

- Start a feature with one view file. Split out `api.ts` or `model.ts` only when
  that responsibility becomes independently useful or testable.
- Extract shared code after a second real caller appears.
- Keep server state authoritative; use React state for presentation state.
- Add shadcn components individually. Do not prebuild a component library.
- Do not add a router, global store, event bus, DI container, command registry,
  or plugin lifecycle without a concrete requirement.
- Comments explain contracts and reasons, not obvious JSX.

## Current Progress

- [x] Empty shared React renderer
- [x] Five-item top menu and dropdown shells
- [x] Fixed seven-item left navigation
- [x] Minimal shadcn foundation and floating Stage view menu
- [ ] Motion feature

## References

- [VS Code source organization](https://github.com/microsoft/vscode/wiki/source-code-organization)
- [Grafana navigation patterns](https://grafana.com/developers/saga/patterns/navigation/)
- [React state structure](https://react.dev/learn/choosing-the-state-structure)
- [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite)
- [shadcn Toggle Group](https://ui.shadcn.com/docs/components/radix/toggle-group)
