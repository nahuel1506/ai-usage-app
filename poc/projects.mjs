
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';

export function projectPath(value) {
  if (typeof value !== 'string') return null;
  let path = value.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
  else if (path.startsWith('\\\\?\\')) path = path.slice(4);
  if (!win32.isAbsolute(path)) return null;
  return win32.normalize(path).replace(/\\+$/, '').toLowerCase();
}

export async function readProjectFolders(file) {
  try {
    const content = await readFile(file, 'utf8');
    if (content.length > 64 * 1024) return {};
    const data = JSON.parse(content);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function entries(value) {
  return Array.isArray(value) ? value.slice(0, 100).filter(item => item && typeof item === 'object') : [];
}

export function prepareProjectIndex(raw, salt, folders = {}) {
  const projects = new Map();
  const roots = [];
  for (const item of raw.projects) {
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim()) continue;
    const reference = createHmac('sha256', salt).update('project/' + item.id).digest('hex').slice(0, 16);
    projects.set(item.id, { reference, name: item.name.trim().slice(0, 120) });
    for (const root of item.roots ?? []) {
      const path = projectPath(root.path);
      if (path) roots.push({ path, reference });
    }
  }
  const threads = new Map();
  const files = new Set();
  for (const item of raw.threads) {
    if (typeof item.id !== 'string') continue;
    const updatedAt = Number.isFinite(item.updatedAt) && item.updatedAt > 0 && item.updatedAt < 253402300800
      ? new Date(item.updatedAt * 1000).toISOString() : undefined;
    threads.set(item.id, { cwd: item.cwd, projectId: item.projectId, name: item.name, updatedAt });
    const path = projectPath(item.path);
    if (path) files.add(path.replace(/\.zst$/, ''));
  }
  const projectList = [...projects.values()];
  const aliases = [];
  for (const alias of entries(folders.aliases)) {
    const path = projectPath(alias.from);
    const target = projectPath(alias.to);
    const references = new Set(roots.filter(root => root.path === target).map(root => root.reference));
    if (path && references.size === 1) aliases.push({ path, reference: references.values().next().value });
  }
  const groups = new Map();
  for (const group of entries(folders.groups)) {
    const path = projectPath(group.root);
    if (!path || groups.has(path) || typeof group.name !== 'string' || !group.name.trim()) continue;
    const reference = createHmac('sha256', salt).update('local-project/' + path).digest('hex').slice(0, 16);
    groups.set(path, { path, reference });
    projectList.push({ reference, name: group.name.trim().slice(0, 120), local: true });
  }
  return { projects, projectList, roots, aliases, groups: [...groups.values()], threads, files };
}

export function sessionProject(index, thread, recordedCwd) {
  if (!index) return {};
  const meta = index.threads.get(thread);
  const nativeTitle = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 120) : undefined;
  if (meta?.projectId) {
    const projectReference = index.projects.get(meta.projectId)?.reference;
    return { nativeTitle, projectReference, projectSource: projectReference ? 'codex' : undefined };
  }

  const path = projectPath(meta?.cwd) ?? projectPath(recordedCwd);
  const candidates = [
    [index.roots, 'folder'],
    [index.aliases, 'folder-alias'],
    [index.groups, 'local-folder'],
  ];
  for (const [roots, projectSource] of candidates) {
    const matches = roots.filter(root => path === root.path || path?.startsWith(root.path + '\\'))
      .sort((left, right) => right.path.length - left.path.length);
    const best = matches[0];
    if (!best) continue;
    if (matches.some(root => root.path.length === best.path.length && root.reference !== best.reference))
      return { nativeTitle };
    return { nativeTitle, projectReference: best.reference, projectSource };
  }
  return { nativeTitle };
}
