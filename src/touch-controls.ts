import type { Renderer } from "./renderer";

export function installTouchControls(renderer: Renderer): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-control]");
  const active = new Map<number, HTMLButtonElement>();
  const release = (pointerId: number): void => {
    const button = active.get(pointerId);
    if (!button) return;
    active.delete(pointerId);
    renderer.setControl(button.dataset.control!, false, `pointer:${pointerId}`);
    if (![...active.values()].includes(button)) button.classList.remove("pressed");
  };
  buttons.forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      active.set(event.pointerId, button);
      button.classList.add("pressed");
      renderer.setControl(button.dataset.control!, true, `pointer:${event.pointerId}`);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      button.addEventListener(type, (event) => release((event as PointerEvent).pointerId));
    }
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    // Keyboard and assistive-technology activation produces a click with no pointer.
    button.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      renderer.setControl(button.dataset.control!, true, "button");
      renderer.setControl(button.dataset.control!, false, "button");
    });
  });
  const clear = (): void => { for (const id of active.keys()) release(id); };
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
}
