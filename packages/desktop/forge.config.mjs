import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopDirectory, '../..');

export default {
  packagerConfig: {
    name: 'Guardian Studio',
    executableName: 'GuardianStudio',
    asar: true,
    extraResource: [path.join(projectRoot, 'dist'), path.join(projectRoot, 'site')],
  },
  makers: [{
    name: '@electron-forge/maker-squirrel',
    config: {
      name: 'GuardianStudio',
      authors: 'Guardian Autopilot',
      description: 'Local-first review of generated-image storage.',
      setupExe: 'GuardianStudioSetup.exe',
      noMsi: true,
    },
  }],
};
