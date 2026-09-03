import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { releaseInfo, updateManifest, sha256, sourceFileAllowed, publicAssets } from './release-utils.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This release script targets Windows x64');
const args = process.argv.slice(2);
const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const version = JSON.parse(fs.readFileSync('package.json')).version;
const info = releaseInfo(version, get('--tag'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const lock = JSON.parse(fs.readFileSync('package-lock.json'));
if (config.version !== version || !cargo.includes(`version = "${version}"`) || lock.version !== version || lock.packages[''].version !== version) throw Error('Version files disagree');
const keyPath = path.join(process.env.LOCALAPPDATA ?? '', 'SlackTrader', 'signing', 'updater.key');
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' };
if (!env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(keyPath)) env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8').trim();
if (!env.TAURI_SIGNING_PRIVATE_KEY) throw Error('Set TAURI_SIGNING_PRIVATE_KEY or create the local signing key documented in docs/UPDATING.md');
function run(command, argv, options = {}) {
  const r = spawnSync(command, argv, { cwd: root, env, stdio: 'inherit', windowsHide: true, ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`${path.basename(command)} exited ${r.status}`);
}
if (!args.includes('--package-only')) run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build']);
const exe = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `${config.productName}_${version}_x64-setup.exe`);
const sig = `${exe}.sig`;
const output = path.join(root, 'release', info.tag);
fs.mkdirSync(output, { recursive: true });
const publicKey = path.join(output, 'updater.pub');
fs.writeFileSync(publicKey, config.plugins.updater.pubkey);
// Uses the same verifier as Tauri; checks the actual installer before publishing metadata.
run('cargo', ['run', '--locked', '--release', '--features', 'tauri/custom-protocol', '--example', 'verify-update', '--', exe, sig, publicKey], { cwd: path.join(root, 'src-tauri') });
fs.copyFileSync(exe, path.join(output, info.installer));
fs.copyFileSync(sig, path.join(output, `${info.installer}.sig`));
fs.copyFileSync('src-tauri/target/release/bluetooth-assistant.exe', path.join(output, info.portable));
const notesFile = get('--notes');
const notes = notesFile ? fs.readFileSync(notesFile, 'utf8') : '界面及稳定性更新。覆盖安装保留持仓和设置。';
fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(updateManifest(info, fs.readFileSync(sig, 'utf8'), notes), null, 2) + '\n');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))].filter(sourceFileAllowed).filter(p => fs.existsSync(p));
// File entries are passed as JSON, never interpolated into shell commands.
const listing = path.join(output, 'source-files.json');
fs.writeFileSync(listing, JSON.stringify(files));
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'zip-source.ps1'), '-Root', root, '-Listing', listing, '-Destination', path.join(output, info.source)]);
const assets = [info.installer, `${info.installer}.sig`, info.portable, info.source, 'latest.json'];
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(p => `${sha256(path.join(output, p))}  ${p}`).join('\n') + '\n');
fs.writeFileSync(path.join(output, 'upload-assets.json'), JSON.stringify(publicAssets(info), null, 2) + '\n');
console.log(`RELEASE_BUILD=PASS version=${version} signed=true output=${output}`);
