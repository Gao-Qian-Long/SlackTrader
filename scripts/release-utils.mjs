import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const repository = 'Gao-Qian-Long/SlackTrader';
export function releaseInfo(version, tag) {
  if (!/^0\.(0|[1-9]\d*)\.0$/.test(version)) throw Error('Public v0.x releases use internal version 0.x.0; increment x for the next release');
  const expectedTag = `v${version.slice(0, -2)}`;
  tag ??= expectedTag;
  if (tag !== expectedTag) throw Error('Use a v0.x release tag matching internal version 0.x.0');
  return { version, tag, title: `SlackTrader ${tag}`, installer: `SlackTrader-${tag}-Setup-x64.exe`, portable: `SlackTrader-${tag}-Portable-x64.exe`, source: `SlackTrader-${tag}-Source.zip` };
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
