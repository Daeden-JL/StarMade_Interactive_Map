# StarMade Interactive Map

An interactive 3D galaxy map for [StarMade](https://www.star-made.org/), served directly from your
game server. The mod runs an embedded web server inside the StarMade server process, reads the live
world database, and streams real‑time entity/player telemetry to a browser‑based [Three.js](https://threejs.org/)
client — think BlueMap, but for StarMade's galaxy.

> Server‑side StarLoader mod (`server_mod: true`). Players don't install anything; they just open the
> map URL in a browser.

## Features

- **3D galaxy & sector view** — fly, orbit, or BlueMap-style **first-person free flight** cameras
  (click the view to capture the mouse; WASD to move, E/Q for up/down, Esc to release).
- **Real‑time tracking** — online players and dynamic ships update live over a WebSocket.
- **Voxel ship/station rendering** with selectable detail tiers: **Generic → Gray → Color → Texture**
  (real StarMade block geometry, per‑block colors, and block textures). Transparent blocks (glass,
  crystal) render with alpha.
- **Search & inspect** systems, stations, ships, and players from the sidebar, with faction colors/names.
- **Persistent UI state** — the last selected object and the last render/texture tier are stored in
  cookies and restored on reload.
- **Startup update check** — on enable, the plugin checks GitHub Releases (authoritative) and
  StarMadeDock for a newer version and logs the result. Non-blocking and best-effort; failures are
  ignored (StarMadeDock is behind Cloudflare and may be unreachable from a server).

## Roadmap

Planned features:

- **Partial block orientation** — non-full blocks (wedges, corners, tetras, heptas) now render with
  their own geometry, but all share a single default orientation. Remaining work: map StarMade's
  per-instance orientation byte to the correct rotation per shape (being tuned against real ships).

Recently shipped:

- ~~BlueMap-style first-person fly view~~ — done (see Features).
- ~~Transparent blocks~~ — glass/crystal (alpha-blended) blocks now render with transparency.

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  StarMade server (JVM)       │         │  Browser                     │
│  ┌────────────────────────┐  │  HTTP   │  ┌────────────────────────┐  │
│  │ StarMadeMapPlugin      │  │ ───────▶│  │ Three.js + TypeScript  │  │
│  │  • Undertow web server │  │  /api   │  │  Vite frontend         │  │
│  │  • reads world DB      │  │         │  │                        │  │
│  │  • WebSocket telemetry │  │ ◀─────▶ │  │  WebSocket /ws/updates │  │
│  └────────────────────────┘  │   ws    │  └────────────────────────┘  │
└─────────────────────────────┘         └──────────────────────────────┘
```

- **Backend** (`src/main/java`) — a `StarMod` plugin that starts an [Undertow](https://undertow.io/)
  web server, queries the StarMade HSQLDB world database, meshes/optimizes voxel entities, and exposes
  JSON APIs plus a WebSocket. The compiled frontend is bundled into the JAR and extracted at runtime to
  `moddata/StarMade_Interactive_Map/web/`.
- **Frontend** (`frontend/`) — a Vite + TypeScript + Three.js single‑page app. `vite build` outputs into
  `src/main/resources/web/` so it ships inside the mod JAR.

### HTTP / WebSocket endpoints

| Path                  | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `/`                   | Static frontend assets                   |
| `/api/galaxy`         | Galaxy state (systems, entities, players)|
| `/api/voxels`         | Voxel mesh data for an entity            |
| `/api/factions`       | Faction id → name map                    |
| `/api/blockmeta`      | Block metadata                           |
| `/api/blocktexture`   | Block textures                           |
| `/api/debug`          | Diagnostics                              |
| `/ws/updates`         | Real‑time player/entity telemetry        |

## Requirements

- A StarMade server with [StarLoader](https://www.star-made.org/) (`starloader_version: 0.1.0`).
- **JDK 8** (the plugin targets Java 8 bytecode).
- **Node.js** + npm (to build the frontend).
- Gradle (or use a `gradlew` wrapper if you add one).
- StarMade library JARs placed in `libs/` (not distributed here):
  - `StarMade.jar` (required to compile)
  - `hsqldb.jar`, `fastutil-6.5.0.jar`, `vecmath.jar` (required to run the tests)

## Building

A `Makefile` orchestrates both halves:

```bash
make build            # build frontend, then the shaded backend JAR
make build-frontend   # npm install + vite build  → src/main/resources/web/
make build-backend    # gradle shadowJar          → build/libs/*.jar
make test             # JUnit 5 tests
make clean            # remove build outputs + generated web assets
```

The output is a single shaded JAR (`build/libs/`) with Undertow and Jackson relocated under
`com.starmade.map.shadow.*` to avoid clashing with StarMade or other mods.

## Releasing & publishing

Tagged builds are published two ways:

- **GitHub Releases** — the downloadable JAR is attached to each release under
  [Releases](https://github.com/Daeden-JL/StarMade_Interactive_Map/releases). Because the build
  requires the proprietary `libs/StarMade.jar` (not distributable), releases are built locally and
  uploaded rather than built in CI.
- **GitHub Packages** — the shaded JAR is published to the GitHub Packages Maven registry as
  `com.starmade.map:starmade-interactive-map`:

  ```bash
  gradle publish \
    -Pgpr.user=<github-username> \
    -Pgpr.token=<token-with-write:packages>
  ```

  Credentials may also come from the `GITHUB_ACTOR` / `GITHUB_TOKEN` environment variables.

## Installing on a server

1. Run `make build`.
2. Copy the JAR from `build/libs/` into your server's StarLoader mods folder.
3. Start the server. On first run the plugin writes a default config and extracts web assets to
   `moddata/StarMade_Interactive_Map/`.
4. Open `http://<server-host>:4243/` in a browser.

### Configuration

On first launch the plugin creates `moddata/StarMade_Interactive_Map/config.properties`:

```properties
# Port for the embedded map web server
webserver.port=4243
```

## Frontend development

For fast iteration without rebuilding the JAR, run the Vite dev server:

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

The dev server proxies `/api` and `/ws` to a backend on `localhost:8888` (see `frontend/vite.config.ts`
and `WebSocketClient.ts`). Point those at wherever your dev backend is listening, then build into the
JAR with `npm run build` (or `make build-frontend`) when you're done.

### Block orientation debug page

`/debug.html` renders every block shape (wedge/corner/tetra/hepta) in each orientation byte, using
the same `blockGeometry` code as the live map, with per-cell axes and a confirmed/hypothesis/unhandled
color key. It's a diagnostic aid for deriving StarMade's per-shape orientation mappings.

## Project layout

```
build.gradle                  # backend build (shadowJar) + test deps
Makefile                      # frontend + backend build orchestration
libs/                         # local StarMade JARs (gitignored, not distributed)
src/main/java/                # plugin, web server, voxel meshing
  com/starmade/map/           #   plugin entry, server, mesh pipeline
src/main/resources/
  mod.json                    # StarLoader mod manifest
  web/                        # built frontend (generated; gitignored)
src/test/java/                # JUnit 5 tests (DB + mesh optimizer)
frontend/                     # Vite + TypeScript + Three.js client
  src/
    renderer/                 # GalaxyRenderer, VoxelModelLoader
    camera/                   # CameraController (fly/orbit)
    ui/                       # DashboardUI (HUD)
    api/                      # WebSocketClient
    util/                     # cookies (persisted UI state)
```

## License

[MIT](LICENSE) © 2026 Daeden
