import express from 'express';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

const DOCS_ORG = 'Product-Studio-ZS';
const REPO_CACHE_TTL = 5 * 60 * 1000;
let repoCache = null;

async function fetchGitHub(path, token) {
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `https://api.github.com${path}${separator}ref=main`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`[DOCS] GitHub API ${res.status} for ${path}: ${res.statusText}`);
    return null;
  }
  return res.json();
}

async function discoverDocsRepos(token) {
  if (repoCache && Date.now() - repoCache.at < REPO_CACHE_TTL) return repoCache.data;

  // Get all repos in the org
  const repos = await fetchGitHub(`/orgs/${DOCS_ORG}/repos?per_page=100&sort=full_name`, token);
  if (!repos || !Array.isArray(repos)) return repoCache?.data || [];

  const docsRepos = [];
  for (const repo of repos) {
    if (repo.archived || repo.fork) continue;
    // Check for docs/ folder
    const docsCheck = await fetchGitHub(`/repos/${repo.full_name}/contents/docs`, token);
    if (docsCheck && Array.isArray(docsCheck) && docsCheck.length > 0) {
      docsRepos.push({ name: repo.name, repo: repo.full_name, path: 'docs' });
    }
    // Also include root .md files (CLAUDE.md, README.md)
    const rootCheck = await fetchGitHub(`/repos/${repo.full_name}/contents`, token);
    if (rootCheck && Array.isArray(rootCheck)) {
      const mdFiles = rootCheck.filter(f => f.type === 'file' && f.name.endsWith('.md'));
      if (mdFiles.length > 0 && !docsRepos.find(r => r.repo === repo.full_name && r.path === '')) {
        docsRepos.push({ name: repo.name, repo: repo.full_name, path: '' });
      }
    }
  }
  return docsRepos;
}

async function fetchRootMdFiles(repoFull, token) {
  const data = await fetchGitHub(`/repos/${repoFull}/contents`, token);
  if (!data || !Array.isArray(data)) return [];
  return data
    .filter(f => f.type === 'file' && f.name.endsWith('.md'))
    .map(f => ({ name: f.name.replace(/\.md$/, ''), type: 'file', path: f.name }));
}

async function fetchTreeRecursive(repoFull, dirPath, token) {
  const url = `/repos/${repoFull}/contents/${dirPath}`;
  const data = await fetchGitHub(url, token);
  if (!data || !Array.isArray(data)) return null;

  const items = [];
  for (const item of data) {
    if (item.type === 'dir') {
      const children = await fetchTreeRecursive(repoFull, item.path, token);
      if (children && children.length > 0) {
        items.push({
          name: item.name,
          type: 'dir',
          path: item.path,
          children,
        });
      }
    } else if (item.type === 'file' && item.name.endsWith('.md')) {
      items.push({
        name: item.name.replace(/\.md$/, ''),
        type: 'file',
        path: item.path,
      });
    }
  }
  return items;
}

router.get('/docs/tree', async (req, res) => {
  try {
    const token = config.github?.token || '';
    const docsRepos = await discoverDocsRepos(token);
    const tree = [];

    for (const repo of docsRepos) {
      const files = repo.path
        ? await fetchTreeRecursive(repo.repo, repo.path, token)
        : await fetchRootMdFiles(repo.repo, token);
      if (files && files.length > 0) {
        tree.push({
          name: repo.name,
          repo: repo.repo,
          files,
        });
      }
    }

    res.json({ tree });
  } catch (error) {
    console.error('docs/tree error:', error);
    res.status(500).json({ error: 'Failed to fetch docs tree' });
  }
});

router.get('/docs/content', async (req, res) => {
  const { repo, path } = req.query;
  if (!repo || !path) return res.status(400).json({ error: 'repo and path required' });

  const token = config.github?.token || '';
  const fullPath = `/repos/${repo}/contents/${path}`;
  const data = await fetchGitHub(fullPath, token);
  if (!data || !data.content) return res.status(404).json({ error: 'File not found' });

  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  res.json({ content, path, repo });
});

export default router;
