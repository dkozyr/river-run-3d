import { installRouteControls } from "./route-controls";
import { installTouchControls } from "./touch-controls";
import { checkWebGPU } from "./startup";

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const status = document.querySelector<HTMLDivElement>("#status");
  const fuel = document.querySelector<HTMLDivElement>("#fuel");
  const lives = document.querySelector<HTMLDivElement>("#lives");
  const score = document.querySelector<HTMLDivElement>("#score");
  const bridge = document.querySelector<HTMLDivElement>("#bridge");
  const highScore = document.querySelector<HTMLDivElement>("#high-score");
  const pause = document.querySelector<HTMLDivElement>("#pause");

  if (!canvas || !status || !fuel || !lives || !score || !bridge || !highScore || !pause) {
    throw new Error("Required DOM elements are missing");
  }

  const controls = document.querySelectorAll<HTMLButtonElement>("[data-control]");
  controls.forEach((button) => { button.disabled = true; });
  status.setAttribute("role", "status");
  status.textContent = "Checking WebGPU availability…";

  try {
    await checkWebGPU();
    status.textContent = "WebGPU is available. Start in reduced-resolution mode? ";
    const launch = document.createElement("button");
    launch.type = "button";
    launch.textContent = "Load game";
    status.append(launch);
    await new Promise<void>((resolve) => launch.addEventListener("click", () => resolve(), { once: true }));
    status.textContent = "Preparing graphics…";
    const adapter = await checkWebGPU();
    const { Renderer } = await import("./renderer");
    const renderer = await Renderer.create(canvas, fuel, lives, score, bridge, highScore, pause, adapter);
    const qualitySelect = document.querySelector<HTMLSelectElement>("#quality")!;
    renderer.onFailure = (message) => {
      qualitySelect.disabled = true;
      status.hidden = false;
      status.textContent = message;
      controls.forEach((button) => { button.disabled = true; });
      document.querySelector<HTMLButtonElement>("#toggle-sound")!.disabled = true;
    };
    if (renderer.hasFailed) return;
    status.hidden = true;
    controls.forEach((button) => { button.disabled = false; });
    qualitySelect.value = "low";
    qualitySelect.disabled = false;
    qualitySelect.addEventListener("change", () => {
      const mode = qualitySelect.value;
      if (mode === "low" || mode === "medium" || mode === "high") renderer.setQuality(mode);
    });
    installTouchControls(renderer);
    const soundButton = document.querySelector<HTMLButtonElement>("#toggle-sound")!;
    let soundEnabled = false;
    soundButton.disabled = false;
    soundButton.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      renderer.setSoundEnabled(soundEnabled);
      soundButton.textContent = `Sound: ${soundEnabled ? "on" : "off"}`;
      soundButton.setAttribute("aria-pressed", String(soundEnabled));
    });
    renderer.start();
  } catch (error) {
    console.error(error);
    status.hidden = false;
    status.textContent = `Failed to initialize WebGPU: ${error instanceof Error ? error.message : String(error)}`;
  }
}

installRouteControls();
void main();
