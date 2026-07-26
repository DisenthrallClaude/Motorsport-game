# APEX HORIZON — World Tour

A photoreal open-city racing game that runs entirely in the browser.
Six cities, one hand-written WebGL2 render pipeline, and **zero downloaded art
assets** — every road, building, tree, sign, car and sound is generated at
load time from code.

**▶ Play: https://disenthrallclaude.github.io/motorsport-game/**

> First-time setup: GitHub Pages has to be switched on once by a repository
> admin — a workflow token isn't allowed to create the Pages site itself.
> In **Settings → Pages**, set the source to **Deploy from a branch →
> `gh-pages` / `(root)`**. That branch already holds a built copy of the site,
> and the workflow refreshes it on every push. (Source = *GitHub Actions* also
> works; the same workflow covers both.)

---

## Destinations

| # | City | Circuit | Conditions |
|---|------|---------|------------|
| 01 | **London** | Westminster Sprint | Wet, low golden-hour sun, Big Ben down the main straight |
| 02 | **Paris** | Boulevard Haussmann | Dry sunset, limestone canyon, Tour Eiffel above the rooftops |
| 03 | **Tokyo** | Shibuya Night Loop | Heavy rain, midnight neon doubled on flooded asphalt |
| 04 | **Beijing** | Chang'an Boulevard | Amber dusk haze, CCTV loop, scarlet gatehouses |
| 05 | **New York** | Midtown Crosstown | Damp late afternoon, brownstone canyons, art-deco crown |
| 06 | **Dubai** | Marina Highline | Blistering midday, glass towers, the fastest circuit on the tour |

## Controls

| Action | Keyboard | Gamepad |
|--------|----------|---------|
| Throttle / brake | `W` `S` or `↑` `↓` | RT / LT |
| Steer | `A` `D` or `←` `→` | Left stick |
| Handbrake | `Space` | A |
| Boost | `Shift` | B |
| Shift up / down | — | RB / LB |
| Camera | `C` | — |
| Reset to track | `R` | — |
| Photo mode | `P` | — |
| Pause | `Esc` | — |
| Hide HUD / FPS / mute | `H` / `F` / `M` | — |

Touch devices get on-screen steering and pedals automatically.

---

## How it renders

The pipeline is written by hand on top of three.js rather than using a stock
post-processing stack, because the wet-street look needs passes that talk to
each other.

**Per frame**

1. **Depth + view-normal prepass** into a half-res RGBA16F target.
2. **SSAO** — normal-oriented hemisphere kernel, then a depth-aware bilateral blur.
3. **Planar reflection probe** re-renders the world mirrored about the road
   plane with an oblique near-plane clip. Unlike screen-space reflections this
   captures geometry that is off screen — building tops, the sky, the car
   beside you — which is exactly what a rain-soaked street shows.
4. **Main HDR pass** with MSAA. The road material blends the reflection using
   Fresnel, a puddle mask and animated rain ripples, and drops its roughness
   where water is standing so the sun's specular reacts too.
5. **Bloom** — threshold with a soft knee, then a COD-style 13-tap
   downsample / tent-upsample pyramid.
6. **Volumetric light shafts** — radial occlusion march from the sun's screen
   position, masked to unoccluded sky.
7. **Composite** — camera motion blur reconstructed from depth and the previous
   view-projection, depth of field, height fog with forward sun scattering,
   ACES tonemapping, lift/gamma/gain grading, chromatic aberration, vignette,
   film grain, unsharp mask.
8. **FXAA** to the screen.

**Two details worth calling out**

- *Motion blur is normalised to a fixed shutter time.* Velocity is
  reconstructed per frame, so without dividing by the frame time the blur
  explodes the moment the frame rate dips.
- *Vehicle materials clamp their own highlights.* A clearcoat at roughness 0.05
  has a GGX peak in the hundreds, so any light behind the camera retro-reflects
  and turns the whole car into a white silhouette once ACES gets hold of it.
  Real renderers avoid this by giving the sun an angular size; here the
  materials floor the roughness used for direct lighting and cap their HDR
  output, so glints still bloom but never flood a panel.

## How the worlds are built

A city is a list of spline control points plus a palette. From that the
generator derives the road slab, kerbs, pavements, gutters, the AI racing line
and a curvature-driven speed profile, then walks the spline placing building
lots, street furniture and landmarks — with keep-out circles so nothing gets
built on top of Big Ben.

Everything is merged down to one mesh per material before it reaches the
renderer, which is what makes the density affordable: a full city is a few
dozen draw calls, and each car went from ~250 meshes to ~20.

Landmarks are modelled procedurally — the Elizabeth Tower's clock dials,
belfry louvres and cast-iron spire; the Eiffel Tower's exponential lattice
curve; the CCTV Headquarters' leaning loop; an art-deco setback tower.

## The car

The body is lofted the way real surfacing works: a series of cross-sections
down the length, skinned together, with a separate greenhouse and roof panel so
the glazing reads as glass. Physics is a bicycle model with per-axle slip
angles, longitudinal load transfer, a friction circle, aero downforce and a
handbrake — which is what lets the car rotate on throttle and hold a drift
instead of feeling like it's on rails.

## Audio

No audio files. The engine is an additive stack of saw oscillators at the
firing harmonics of a V12 plus filtered noise, with the upper orders fading in
under load and a lowpass tracking revs. Tyres, wind and impacts are shaped
noise.

---

## Running it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → docs/
npm run preview
```

Deep links are handy for jumping straight into a scene:

```
?city=tokyo&auto=1                    boot straight into a race
?city=london&t=0.235&speed=34         park the car at a point on the circuit
?city=paris&q=ultra&rivals=7&laps=3
```

`city` · `q` (low/med/high/ultra) · `laps` · `rivals` · `assists` · `t` ·
`speed` · `cam` · `rain` · `preset`

## Requirements

A browser with WebGL2. Quality auto-scales: if the frame rate drops the game
steps down a tier on its own, and `low` disables reflections, SSAO and light
shafts for integrated graphics.

## Licence

MIT.
