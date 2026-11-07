// Reset an admin password from the server shell (requires shell access, so only the server owner can use it).
// Usage: node src/cli/reset-password.js <username> <new-password>
//   (Docker) docker compose exec ai-holding node src/cli/reset-password.js admin 'NewPassword123'
import { config, loadAppSecret } from '../config.js';
import { openDb, closeDb, q, now } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 10) {
  console.error('Usage: node src/cli/reset-password.js <username> <new-password (min 10 chars)>');
  process.exit(1);
}
loadAppSecret({ warn() {} });
openDb(config.dbPath);
const user = q.get('SELECT id FROM users WHERE username = ?', username);
if (!user) {
  console.error(`User "${username}" tidak ditemukan.`);
  closeDb();
  process.exit(1);
}
q.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', await hashPassword(password), now(), user.id);
q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
q.run("INSERT INTO audit_logs(actor, action, target, created_at) VALUES ('cli', 'password_reset', ?, ?)", username, now());
closeDb();
console.log(`Password untuk "${username}" diganti. Semua sesi aktif dikeluarkan.`);
