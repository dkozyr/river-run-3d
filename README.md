# River Run 3D

A browser flight game built with TypeScript, WebGPU, and WGSL ray marching.
Terrain, islands, bridges, fuel depots, and enemies are generated procedurally
from a seed. Audio is synthesized with the Web Audio API.

## Local development

Use Node.js 22 (`nvm use` if you use nvm) and a WebGPU-capable browser.

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. WebGPU requires HTTPS or localhost, and availability
depends on your browser, GPU, and drivers.

The game appears in a centered, responsive window. Open **How to play** for the
full guide. Phones and tablets have touch buttons for steering, speed, firing,
pause, camera switching, and restart. Multiple simultaneous touches are supported.

## Controls

- `↑/↓` — faster/slower
- `←/→` — move while held
- `Space` — fire
- `C` — 3D/top-down camera
- `WASD` — orbit 3D camera while held
- `R` — restart after game over
- `H` — pause
- `F3` — debug HUD

Each life waits for a key before launch. Respawns start in the last destroyed
bridge gap. Every 8,192 points adds one plane. Audio is off by default; use the Sound button to enable or mute it. High scores are stored locally in your browser.

Set the world seed with `?seed=123456789` or `?seed=0xffffffff`.
Use `?straight=1` for a straight river; the default is curved.
Combine parameters with `?seed=123456789&straight=1`.

## Production build

```bash
npm run build
npm run preview
```

The build type-checks the source and produces `dist/`. Asset URLs are relative,
so the build works at a domain root or under a GitHub repository path.

## Source layout

- `src/world.ts` — seeded procedural world generation and GPU data packing
- `src/renderer.ts` — rendering, game state, collisions, and input
- `src/shaders/raymarch.wgsl` — procedural geometry, materials, and lighting
- `src/audio.ts` — synthesized game audio
- `src/main.ts` — browser initialization
