import { createUISFX, type CueName } from "uisfx";

export type { CueName } from "uisfx";

const player = createUISFX({
  pack: "zen",
  volume: 0.42,
  preferences: { key: "easypto.sound" },
});

let unlockInstalled = false;

export function initializeUISFX() {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;

  const unlock = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    void player.unlock();
  };

  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

export function playUISFX(cue: CueName) {
  return player.play(cue);
}

export function setUISFXEnabled(enabled: boolean) {
  player.setEnabled(enabled);
}

export function isUISFXEnabled() {
  return player.isEnabled();
}
