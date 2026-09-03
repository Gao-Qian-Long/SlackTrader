import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const repository = 'Gao-Qian-Long/SlackTrader';
export function releaseInfo(version, tag = `v${version}`) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `v${version}`) throw Error('Use a stable vMAJOR.MINOR.PATCH tag matching the app version');
  return { version, tag, installer: `SlackTrader-${tag}-Setup-x64.exe`, portable: `SlackTrader-${tag}-Portable-x64.exe`, source: `SlackTrader-${tag}-Source.zip` };
}
export function updateManifest(info, signature, notes = '', date = new Date().toISOString()) {
  if (!signature.trim() || !Buffer.from(signature.trim(), 'base64').toString().includes('untrusted comment:')) throw Error('Missing updater signature');
  if (!Number.isFinite(Date.parse(date))) throw Error('Invalid release date');
  return { version: info.version, notes, pub_date: date, platforms: { 'windows-x86_64': {
    signature: signature.trim(), url: `https://github.com/${repository}/releases/download/${info.tag}/${info.installer}`,
  } } };
}
export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function sourceFileAllowed(file) {
  return !file.split(/[\\/]/).some(part => /^(?:node_modules|target|dist|release|artifacts|\.git|user-data-backup|signing)$/i.test(part)) &&
    !/(?:\.key(?:\.|$)|\.pem$|\.pfx$|\.env(?:\.|$)|\.log$|before-rollback$)/i.test(path.basename(file));
}
