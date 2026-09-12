import { installRouteControls } from "./route-controls";
import { installTouchControls } from "./touch-controls";
import { Renderer } from "./renderer";

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

  if (!navigator.gpu) {
    status.textContent = "WebGPU is not supported by this browser.";
    return;
  }

  try {
    const renderer = await Renderer.create(canvas, fuel, lives, score, bridge, highScore, pause);
    status.remove();
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
    status.textContent = `Failed to initialize WebGPU: ${error instanceof Error ? error.message : String(error)}`;
  }
}

installRouteControls();
void main();
