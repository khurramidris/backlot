// electron-builder never copies a folder called node_modules into extraResources, but the engine needs its own.
// After the app is packed (and before it is signed), copy them in next to the engine.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const from = path.join(__dirname, '..', 'stage', 'engine', 'node_modules');
  const to = path.join(resources, 'engine', 'node_modules');
  if (!fs.existsSync(from)) throw new Error(`Run "npm run prepare:app" first: ${from} is missing.`);
  fs.cpSync(from, to, { recursive: true });
  console.log(`  • engine dependencies copied  to=${to.replace(appOutDir, '.')}`);
};
