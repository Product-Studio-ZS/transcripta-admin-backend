import express from 'express';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

const DOCS_REPOS = [
  { name: 'meta', repo: 'Product-Studio-ZS/transcripta', path: 'docs' },
  { name: 'backend', repo: 'Product-Studio-ZS/transcripta-backend', path: 'docs' },
  { name: 'frontend', repo: 'Product-Studio-ZS/transcripta-frontend', path: 'docs' },
  { name: 'admin-panel', repo: 'Product-Studio-ZS/transcripta-admin-panel', path: 'docs' },
  { name: 'support-bot', repo: 'Product-Studio-ZS/transcripta-support-bot', path: 'docs' },
  { name: 'landing', repo: 'Product-Studio-ZS/transcripta-landing', path: 'docs' },
  { name: 'ai', repo: 'Product-Studio-ZS/transcripta-ai', path: 'docs' },
  { name: 'deploy', repo: 'Product-Studio-ZS/transcripta-deploy', path: 'docs' },
];

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
    const tree = [];

    for (const repo of DOCS_REPOS) {
      const files = await fetchTreeRecursive(repo.repo, repo.path, token);
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
