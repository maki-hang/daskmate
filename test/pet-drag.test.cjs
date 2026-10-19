const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PetDrag, PET_BOUNDS, clampPetPosition } = require('../src/core/pet-drag.cjs');
function fixture() {
  let position = [100, 100], cursor = { x: 200, y: 200 }, ended = 0, destroyed = false;
  const window = { isDestroyed: () => destroyed, getPosition: () => [...position], getSize: () => [260, 360], setPosition: (x, y) => { position = [x, y]; }, setIgnoreMouseEvents: value => assert.equal(value, false) };
  const screen = { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: point => ({ workArea: point.x < 0 ? { x: -1280, y: 0, width: 1280, height: 1024 } : { x: 0, y: 0, width: 1920, height: 1080 } }) };
  const drag = new PetDrag(window, screen, () => ended++);
  return { drag, window, setCursor: point => { cursor = point; }, destroy: () => { destroyed = true; }, ended: () => ended };
}
test('pet drag follows screen coordinates and ends once without later movement', () => {
  const f = fixture();
  try {
    f.drag.start(); f.drag.start(); f.setCursor({ x: 245, y: 230 }); f.drag.move();
    assert.deepEqual(f.window.getPosition(), [145, 130]);
    f.drag.end(); f.drag.end(); f.setCursor({ x: 800, y: 800 }); f.drag.move();
    assert.deepEqual(f.window.getPosition(), [145, 130]); assert.equal(f.ended(), 1); assert.equal(f.drag.timer, null);
  } finally { f.drag.end(); }
});
test('pet drag crosses to a negative-coordinate monitor and stays within its work area', () => {
  const f = fixture();
  try {
    f.drag.start(); f.setCursor({ x: -500, y: 400 }); f.drag.move(); assert.deepEqual(f.window.getPosition(), [-600, 300]);
    f.setCursor({ x: -1300, y: 1200 }); f.drag.move(); assert.deepEqual(f.window.getPosition(), [-1315, 786]);
    f.setCursor({ x: 2100, y: 1300 }); f.drag.move(); assert.deepEqual(f.window.getPosition(), [1695, 842]);
  } finally { f.drag.end(); }
});
test('all four edges constrain the pet instead of the transparent window', () => {
  const area = { x: -1280, y: -1024, width: 1280, height: 984 };
  for (const x of [-10000, 10000]) for (const y of [-10000, 10000]) {
    const pos = clampPetPosition({ x, y }, area);
    const left = pos.x + PET_BOUNDS.x, top = pos.y + PET_BOUNDS.y;
    assert.equal(left, x < 0 ? area.x : area.x + area.width - PET_BOUNDS.width);
    assert.equal(top, y < 0 ? area.y : area.y + area.height - PET_BOUNDS.height);
    assert.deepEqual(clampPetPosition(pos, area), pos, 'restoring an edge position keeps it unchanged');
  }
});
test('pet can reach the desktop top-left and stops there', () => {
  const f = fixture();
  try {
    f.drag.start(); f.setCursor({ x: 0, y: 0 }); f.drag.move();
    assert.deepEqual(f.window.getPosition(), [-35, -53]);
  } finally { f.drag.end(); }
});
test('destroying the pet stops an active drag without persisting a destroyed window', () => {
  const f = fixture(); f.drag.start(); f.destroy(); f.drag.move();
  assert.equal(f.drag.active, false); assert.equal(f.drag.timer, null); assert.equal(f.ended(), 0);
});
