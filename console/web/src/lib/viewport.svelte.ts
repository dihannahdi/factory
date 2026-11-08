// Single source for the one layout switch: <= 760 px is the phone layout.
class Viewport {
  mobile = $state(false);
  constructor() {
    if (typeof window === "undefined") return;
    const q = window.matchMedia("(max-width: 760px)");
    this.mobile = q.matches;
    q.addEventListener("change", () => (this.mobile = q.matches));
  }
}
export const vp = new Viewport();
