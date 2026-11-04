// Browser fixtures use the same Project Python as the normal launcher.
const fs = require('node:fs');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..');

module.exports = function sharedPython(configured) {
  if (configured) {
    // Preserve explicit command names; anchor path values to this project.
    return path.isAbsolute(configured) || !/[\\/]/.test(configured) ?
      configured : path.resolve(projectRoot, configured);
  }
  let directory = path.resolve(__dirname);
  while (path.basename(directory).toLowerCase() !== 'project') {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Project workspace not found. Place this project inside Project.');
    directory = parent;
  }
  const executable = path.join(directory, '.venv',
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error('Shared Project Python is missing: ' + executable + '. Initialize Project/.venv first.');
  }
  return executable;
};
