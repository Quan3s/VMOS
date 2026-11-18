import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spawn tiến trình producer mới (detached) rồi để tiến trình hiện tại tự exit.
 * Dùng sau khi đăng nhập lại thành công để browser/session cũ không bị kẹt.
 */
export function respawnProducer({
  script = path.join(__dirname, '..', 'producer.js'),
  args = process.argv.slice(2),
  env = process.env,
  spawn = nodeSpawn,
  detached = true,
} = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...env, VMOS_RESPAWNED: '1' },
    stdio: 'inherit',
    detached,
  });
  if (typeof child.unref === 'function') child.unref();
  return child;
}

/** Gọi ở nơi cần: respawn rồi kết thúc process hiện tại. */
export function respawnAndExit(options = {}, exit = () => process.exit(0)) {
  respawnProducer(options);
  return exit();
}
