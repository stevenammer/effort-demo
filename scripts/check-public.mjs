// Publication guard. Private terms are salted hashes outside this repository.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const termHash = (salt, term) => sha(`${salt}:${normalize(term).replace(/ /g, '')}`);

export function windows(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  const result = new Set();
  for (let index = 0; index < words.length; index += 1) {
    let value = '';
    for (let count = 0; count < 3 && index + count < words.length; count += 1) {
      value += words[index + count];
      result.add(value);
    }
  }
  return result;
}

const rules = [
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['openai-token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['private-session-link', new RegExp('Claude' + '-Session:|claude\\.ai/code/' + 'session_[A-Za-z0-9]+', 'g')],
];

export function denylistPath() {
  return process.env.EFFORT_DENYLIST || process.env.SSS_DENYLIST ||
    join(homedir(), '.config', 'sss', 'denylist.json');
}

export function loadDenylist(path = denylistPath()) {
  if (!existsSync(path)) return { configured: false, salt: '', hashes: new Set() };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data.salt !== 'string' || !Array.isArray(data.hashes)) throw Error('Invalid private denylist.');
  return { configured: true, salt: data.salt, hashes: new Set(data.hashes) };
}

export function scanPublicText(path, text, denylist = loadDenylist()) {
  const findings = [];
  if (/(?:^|\/)\.env(?:$|\.)/.test(path) && !path.endsWith('.env.example') ||
      /(?:^|\/)\.claude\/settings\.local\.json(?:$|\.)/.test(path) ||
      /(?:^|\/)(?:\.npmrc|\.netrc|id_rsa|id_ed25519)$/.test(path)) {
    findings.push({ path, line: 1, rule: 'private-local-file' });
  }
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ path, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  if (path === '[commit-metadata]' && /^(?:author|committer) .*@(?:gmail|yahoo|hotmail|outlook)\.com>/mi.test(text)) {
    findings.push({ path, line: 1, rule: 'personal-commit-email' });
  }
  if (denylist.hashes.size) {
    for (const value of windows(`${text} ${path}`)) {
      if (denylist.hashes.has(sha(`${denylist.salt}:${value}`))) {
        findings.push({ path, line: 1, rule: 'private-denylist' });
        break;
      }
    }
  }
  return findings;
}

function files(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others',
      '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory)) {
        if (entry === '.git' || entry === 'node_modules') continue;
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full); else out.push(relative(root, full));
      }
    };
    walk(root);
    return out;
  }
}

export function checkPublicRepository(root = process.cwd(), denylist = loadDenylist()) {
  const findings = [];
  for (const path of files(root)) {
    let raw;
    try { raw = readFileSync(join(root, path)); } catch { continue; }
    // Binary assets can contain arbitrary byte sequences. They have no word windows.
    const text = raw.includes(0) ? '' : raw.toString('utf8');
    findings.push(...scanPublicText(path, text, denylist));
  }
  for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  if (findings.length) return false;
  const summary = denylist.configured ? `${denylist.hashes.size} private denylisted terms` :
    'no private denylist configured';
  console.log(`PASS: ${files(root).length} files checked, ${summary}.`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = checkPublicRepository() ? 0 : 1;
}
