// Electron supplies cursor and window coordinates in screen DIP, including mixed-DPI monitors.
// Match #pet in pet.css: transparent window padding may extend past the desktop.
const PET_BOUNDS = Object.freeze({ x: 35, y: 53, width: 190, height: 185 });
function clampPetPosition(position, area) {
  const minX = area.x - PET_BOUNDS.x, minY = area.y - PET_BOUNDS.y;
  return {
    x: Math.round(Math.min(Math.max(position.x, minX), minX + Math.max(0, area.width - PET_BOUNDS.width))),
    y: Math.round(Math.min(Math.max(position.y, minY), minY + Math.max(0, area.height - PET_BOUNDS.height)))
  };
}
class PetDrag {
  constructor(window, screen, onEnd = () => {}) {
    this.window = window;
    this.screen = screen;
    this.onEnd = onEnd;
    this.active = false;
  }
  start() {
    if (this.active || this.window.isDestroyed()) return;
    this.origin = this.window.getPosition();
    this.cursor = this.screen.getCursorScreenPoint();
    this.active = true;
    this.window.setIgnoreMouseEvents(false);
    this.timer = setInterval(() => this.move(), 16);
  }
  move() {
    if (!this.active) return;
    if (this.window.isDestroyed()) { this.end(); return; }
    const point = this.screen.getCursorScreenPoint();
    const area = this.screen.getDisplayNearestPoint(point).workArea;
    const { x, y } = clampPetPosition({ x: this.origin[0] + point.x - this.cursor.x, y: this.origin[1] + point.y - this.cursor.y }, area);
    const current = this.window.getPosition();
    if (current[0] !== x || current[1] !== y) this.window.setPosition(x, y);
  }
  end() {
    if (!this.active) return;
    clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    if (!this.window.isDestroyed()) this.onEnd();
  }
}
module.exports = { PetDrag, PET_BOUNDS, clampPetPosition };
