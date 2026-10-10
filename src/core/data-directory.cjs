const fs = require('node:fs');
const path = require('node:path');

// Keep existing users on the same data and single-instance lock after rebranding.
function dataDirectory(appData, env = process.env) {
  const custom = env.DESKMATE_DATA_DIR || env.LONGLING_DATA_DIR;
  if (custom) return path.resolve(custom);
  const current = path.join(appData, 'DeskMate');
  const legacy = path.join(appData, 'Longling PC Assistant');
  return !fs.existsSync(path.join(current, 'assistant.json')) && fs.existsSync(path.join(legacy, 'assistant.json')) ? legacy : current;
}
module.exports = { dataDirectory };
