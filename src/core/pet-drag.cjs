// Electron supplies cursor and window coordinates in screen DIP, including mixed-DPI monitors.
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
    const [width, height] = this.window.getSize();
    const x = Math.round(Math.min(Math.max(this.origin[0] + point.x - this.cursor.x, area.x), area.x + Math.max(0, area.width - width)));
    const y = Math.round(Math.min(Math.max(this.origin[1] + point.y - this.cursor.y, area.y), area.y + Math.max(0, area.height - height)));
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
module.exports = { PetDrag };
