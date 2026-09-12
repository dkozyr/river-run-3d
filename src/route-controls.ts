export function installRouteControls(): void {
  const url = new URL(window.location.href);
  const rawSeed = url.searchParams.get("seed");
  const parsed = Number(rawSeed);
  const hasValidSeed = rawSeed !== null && rawSeed.trim() !== "" && Number.isFinite(parsed);
  const seed = hasValidSeed
    ? Math.trunc(parsed) >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0];
  if (!hasValidSeed) {
    url.searchParams.set("seed", String(seed));
    window.history.replaceState(window.history.state, "", url.href);
  }
  const straight = url.searchParams.get("straight") === "1";
  const toggle = document.querySelector<HTMLButtonElement>("#toggle-river")!;
  document.querySelector("#route-seed")!.textContent = `SEED ${seed}`;
  toggle.setAttribute("aria-pressed", String(straight));
  toggle.textContent = `Straight river: ${straight ? "on" : "off"}`;

  toggle.addEventListener("click", () => {
    url.searchParams.set("seed", String(seed));
    url.searchParams.set("straight", straight ? "0" : "1");
    window.location.assign(url.href);
  });
  document.querySelector("#random-seed")!.addEventListener("click", () => {
    let next = crypto.getRandomValues(new Uint32Array(1))[0];
    if (next === seed) next = (next + 1) >>> 0;
    url.searchParams.set("seed", String(next));
    window.location.assign(url.href);
  });
}
