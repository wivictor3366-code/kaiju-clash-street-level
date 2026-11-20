// Keyboard + Gamepad -> input bitmask. Sampled synchronously at the top of each sim tick
// (no event-queue latency). SOCD-cleaned (left+right = neutral).
import { IN_L, IN_R, IN_U, IN_D, IN_A, IN_B, IN_S, IN_G, IN_X, IN_Y, IN_Z, IN_W } from "./sim";

type KeyMap = [string, number][];
const LEFT: KeyMap = [["KeyA", IN_L], ["KeyD", IN_R], ["KeyW", IN_U], ["KeyS", IN_D], ["KeyF", IN_A], ["KeyG", IN_B], ["KeyH", IN_S], ["KeyR", IN_G], ["KeyT", IN_X], ["KeyE", IN_Z], ["KeyC", IN_W], ["KeyQ", IN_Y], ["ShiftLeft", IN_Y]];
const RIGHT: KeyMap = [["ArrowLeft", IN_L], ["ArrowRight", IN_R], ["ArrowUp", IN_U], ["ArrowDown", IN_D], ["KeyJ", IN_A], ["KeyK", IN_B], ["KeyL", IN_S], ["KeyU", IN_G], ["KeyI", IN_X], ["KeyP", IN_Z], ["KeyN", IN_W], ["KeyO", IN_Y], ["Space", IN_Y], ["ShiftRight", IN_Y], ["Numpad0", IN_Y], ["Numpad1", IN_A], ["Numpad2", IN_B], ["Numpad3", IN_S], ["Numpad4", IN_G], ["Numpad5", IN_X]];

export class Input {
  private keys = new Set<string>();
  // presses are latched until the next sim tick consumes them, so a tap that goes
  // down+up between two ticks (fast fingers / dropped frame) is never lost
  private latch = new Set<string>();
  private down = (e: KeyboardEvent) => {
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    this.keys.add(e.code);
    this.latch.add(e.code);
  };
  private up = (e: KeyboardEvent) => this.keys.delete(e.code);
  private blur = () => {
    this.keys.clear();
    this.latch.clear();
  };

  constructor() {
    window.addEventListener("keydown", this.down);
    window.addEventListener("keyup", this.up);
    window.addEventListener("blur", this.blur);
  }
  dispose() {
    window.removeEventListener("keydown", this.down);
    window.removeEventListener("keyup", this.up);
    window.removeEventListener("blur", this.blur);
  }
  private map(m: KeyMap): number {
    let v = 0;
    for (let i = 0; i < m.length; i++) if (this.keys.has(m[i][0]) || this.latch.has(m[i][0])) v |= m[i][1];
    return v;
  }
  private pad(i: number): number {
    const gp = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads()[i] : null;
    if (!gp) return 0;
    let v = 0;
    const b = (k: number) => gp.buttons[k] && gp.buttons[k].pressed;
    if (gp.axes[0] < -0.45 || b(14)) v |= IN_L;
    if (gp.axes[0] > 0.45 || b(15)) v |= IN_R;
    if (gp.axes[1] > 0.55 || b(13)) v |= IN_D;
    if (gp.axes[1] < -0.55 || b(12)) v |= IN_U;
    if (b(2)) v |= IN_A;
    if (b(3)) v |= IN_B;
    if (b(1)) v |= IN_S;
    if (b(0)) v |= IN_G;
    if (b(5) || b(7)) v |= IN_X;
    if (b(10)) v |= IN_Z; // L-stick click: signature 1
    if (b(11)) v |= IN_W; // R-stick click: signature 2
    if (b(4) || b(6)) v |= IN_Y; // LB / LT: hold to drive the street-level spotter
    return v;
  }
  private clean(v: number): number {
    if ((v & (IN_L | IN_R)) === (IN_L | IN_R)) v &= ~(IN_L | IN_R);
    return v;
  }
  /** single local player: both key clusters + gamepad 0 */
  solo(): number {
    return this.clean(this.map(LEFT) | this.map(RIGHT) | this.pad(0));
  }
  /** shared keyboard: P1 = WASD + FGHRT (pad 0), P2 = arrows + JKLUI (pad 1) */
  p1(): number {
    return this.clean(this.map(LEFT) | this.pad(0));
  }
  p2(): number {
    return this.clean(this.map(RIGHT) | this.pad(1));
  }
  /** call once after every sim tick */
  flush() {
    if (this.latch.size) this.latch.clear();
  }
}
