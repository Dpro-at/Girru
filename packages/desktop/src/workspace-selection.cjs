'use strict';
const fs = require('node:fs');
const path = require('node:path');
const INVALID_SELECTION = '<invalid-saved-workspace>';
function readSelection(settingsDir) {
  const file = path.join(settingsDir, 'workspace.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.dir !== 'string' || !path.isAbsolute(value.dir)) return INVALID_SELECTION;
    try { return fs.realpathSync(value.dir); } catch { return value.dir; }
  } catch (error) { return error.code === 'ENOENT' ? null : INVALID_SELECTION; }
}
/** New installs use an isolated app-owned folder; existing data is never replaced. */
function createWorkspace(settingsDir) {
  const dir = path.join(settingsDir, 'workspaces', require('node:crypto').randomUUID());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(settingsDir, 'workspace.json');
  const temporary = file + '.' + require('node:crypto').randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ dir, newWorkspace: true }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return dir;
}
module.exports = { readSelection, createWorkspace, INVALID_SELECTION };
