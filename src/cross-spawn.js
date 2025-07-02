import { spawn, spawnSync } from 'node:child_process';
spawn.sync = spawnSync;
export default spawn;
