import type { Renderer } from "./renderer";

export function installTouchControls(renderer: Renderer): void {
  const joystick = document.querySelector<HTMLButtonElement>("[data-joystick]");
  let stickPointer: number | undefined;
  const directions = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  const resetStick = (): void => {
    stickPointer = undefined;
    directions.forEach((code) => renderer.setControl(code, false, "joystick"));
    joystick?.classList.remove("pressed");
    joystick?.style.removeProperty("--stick-x");
    joystick?.style.removeProperty("--stick-y");
  };
  const moveStick = (event: PointerEvent): void => {
    if (!joystick || event.pointerId !== stickPointer) return;
    const rect = joystick.getBoundingClientRect();
    const radius = rect.width * 0.28;
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const scale = Math.max(1, Math.hypot(dx, dy) / radius);
    const x = dx / scale;
    const y = dy / scale;
    joystick.style.setProperty("--stick-x", `${x}px`);
    joystick.style.setProperty("--stick-y", `${y}px`);
    const deadZone = radius * 0.25;
    const pressed = [x < -deadZone, x > deadZone, y < -deadZone, y > deadZone];
    directions.forEach((code, index) => renderer.setControl(code, pressed[index], "joystick"));
  };
  joystick?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || joystick.disabled || stickPointer !== undefined) return;
    event.preventDefault();
    stickPointer = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    joystick.classList.add("pressed");
    moveStick(event);
  });
  joystick?.addEventListener("pointermove", moveStick);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    joystick?.addEventListener(type, (event) => {
      if ((event as PointerEvent).pointerId === stickPointer) resetStick();
    });
  }
  joystick?.addEventListener("contextmenu", (event) => event.preventDefault());
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
  const clear = (): void => {
    resetStick();
    for (const id of active.keys()) release(id);
  };
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
}
