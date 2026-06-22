#!/usr/bin/env node
/**
 * cross-publish.mjs
 *
 * Publishes draft articles from docs/articles/ to dev.to and Hashnode.
 * Reads frontmatter from each .md file. If `published: false`, calls both APIs.
 * Updates frontmatter to `published: true` and writes to content/publish-log.json.
 *
 * Required env vars:
 *   DEVTO_API_KEY            — dev.to API key (repository secret)
 *   HASHNODE_ACCESS_TOKEN    — Hashnode personal access token (repository secret)
 *   HASHNODE_PUBLICATION_ID  — Hashnode publication ID (repository secret)
 *
 * Usage:
 *   node bin/cross-publish.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARTICLES_DIR = join(REPO_ROOT, 'docs', 'articles');
const PUBLISH_LOG = join(REPO_ROOT, 'content', 'publish-log.json');

const DEVTO_API_KEY = process.env.DEVTO_API_KEY;
const HASHNODE_ACCESS_TOKEN = process.env.HASHNODE_ACCESS_TOKEN;
const HASHNODE_PUBLICATION_ID = process.env.HASHNODE_PUBLICATION_ID;

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown file body.
 * Returns { frontmatter: Record<string,string|boolean|string[]>, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();

    if (val === 'true') {
      frontmatter[key] = true;
    } else if (val === 'false') {
      frontmatter[key] = false;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      // Simple array: ["a", "b", "c"]
      frontmatter[key] = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      frontmatter[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body };
}

/**
 * Serialize frontmatter back to YAML block. Sets published: true.
 */
function serializeFrontmatter(frontmatter, body) {
  const lines = [];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map(v => `"${v}"`).join(', ')}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// dev.to publisher
// ---------------------------------------------------------------------------

async function publishToDevTo(article) {
  const { title, description, tags, canonical_url, body, markdown } = article;

  const payload = {
    article: {
      title,
      body_markdown: markdown,
      published: true,
      tags: Array.isArray(tags) ? tags : [],
      canonical_url: canonical_url || undefined,
      description: description || undefined,
    },
  };

  console.log(`[dev.to] Publishing: "${title}"`);

  const response = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': DEVTO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data?.error || JSON.stringify(data);
    throw new Error(`dev.to API error ${response.status}: ${errorMsg}`);
  }

  if (!data.id) {
    throw new Error(`dev.to API returned unexpected response: ${JSON.stringify(data)}`);
  }

  console.log(`[dev.to] Published successfully — ID: ${data.id}, URL: ${data.url}`);
  return { id: String(data.id), url: data.url };
}

// ---------------------------------------------------------------------------
// Hashnode publisher
// ---------------------------------------------------------------------------

async function publishToHashnode(article) {
  const { title, description, tags, canonical_url, markdown } = article;

  const tagObjects = (Array.isArray(tags) ? tags : []).map(t => ({
    name: t,
    slug: t.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  }));

  const mutation = `
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post {
          id
          url
        }
      }
    }
  `;

  const variables = {
    input: {
      title,
      contentMarkdown: markdown,
      publicationId: HASHNODE_PUBLICATION_ID,
      tags: tagObjects,
      originalArticleURL: canonical_url || undefined,
      metaTags: description
        ? { description }
        : undefined,
    },
  };

  console.log(`[Hashnode] Publishing: "${title}"`);

  const response = await fetch('https://gql.hashnode.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: HASHNODE_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Hashnode API HTTP error ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data.errors && data.errors.length > 0) {
    const errMessages = data.errors.map(e => e.message).join('; ');
    throw new Error(`Hashnode GraphQL errors: ${errMessages}`);
  }

  const post = data?.data?.publishPost?.post;
  if (!post?.id) {
    throw new Error(`Hashnode API returned unexpected response: ${JSON.stringify(data)}`);
  }

  console.log(`[Hashnode] Published successfully — ID: ${post.id}, URL: ${post.url}`);
  return { id: post.id, url: post.url };
}

// ---------------------------------------------------------------------------
// Publish log
// ---------------------------------------------------------------------------

async function loadPublishLog() {
  try {
    const raw = await readFile(PUBLISH_LOG, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { articles: {} };
  }
}

async function savePublishLog(log) {
  await writeFile(PUBLISH_LOG, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Validate required secrets
  const missing = [];
  if (!DEVTO_API_KEY) missing.push('DEVTO_API_KEY');
  if (!HASHNODE_ACCESS_TOKEN) missing.push('HASHNODE_ACCESS_TOKEN');
  if (!HASHNODE_PUBLICATION_ID) missing.push('HASHNODE_PUBLICATION_ID');

  if (missing.length > 0) {
    console.error(`ERROR: Missing required environment variables: ${missing.join(', ')}`);
    console.error('Set these as repository secrets in GitHub Actions.');
    process.exit(1);
  }

  // Load article files
  const files = (await readdir(ARTICLES_DIR)).filter(f => f.endsWith('.md'));

  if (files.length === 0) {
    console.log('No markdown files found in docs/articles/ — nothing to publish.');
    return;
  }

  const log = await loadPublishLog();
  let anyPublished = false;
  let anyFailed = false;

  for (const filename of files) {
    const filepath = join(ARTICLES_DIR, filename);
    const raw = await readFile(filepath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);

    if (frontmatter.published === true) {
      console.log(`[skip] ${filename} — already published`);
      continue;
    }

    const { title, description, tags, canonical_url } = frontmatter;

    if (!title) {
      console.warn(`[warn] ${filename} — missing title in frontmatter, skipping`);
      continue;
    }

    // Strip HTML comments (demo gif placeholders etc.) from body for publishing
    const cleanBody = body.replace(/<!--[\s\S]*?-->/g, '').trim();

    const article = { title, description, tags, canonical_url, markdown: cleanBody };
    const slug = filename.replace(/\.md$/, '');
    const logEntry = log.articles[slug] || {};

    console.log(`\n=== Publishing: ${filename} ===`);

    // dev.to
    let devtoResult = null;
    if (logEntry.devto?.id) {
      console.log(`[dev.to] Already logged as published (ID: ${logEntry.devto.id}) — skipping`);
      devtoResult = logEntry.devto;
    } else {
      try {
        devtoResult = await publishToDevTo(article);
        logEntry.devto = { ...devtoResult, publishedAt: new Date().toISOString() };
        log.articles[slug] = logEntry;
        await savePublishLog(log);
      } catch (err) {
        console.error(`[dev.to] FAILED for ${filename}: ${err.message}`);
        anyFailed = true;
      }
    }

    // Hashnode
    let hashnodeResult = null;
    if (logEntry.hashnode?.id) {
      console.log(`[Hashnode] Already logged as published (ID: ${logEntry.hashnode.id}) — skipping`);
      hashnodeResult = logEntry.hashnode;
    } else {
      try {
        hashnodeResult = await publishToHashnode(article);
        logEntry.hashnode = { ...hashnodeResult, publishedAt: new Date().toISOString() };
        log.articles[slug] = logEntry;
        await savePublishLog(log);
      } catch (err) {
        console.error(`[Hashnode] FAILED for ${filename}: ${err.message}`);
        anyFailed = true;
      }
    }

    // Only mark as published in frontmatter if both platforms succeeded
    if (devtoResult && hashnodeResult) {
      const updated = { ...frontmatter, published: true };
      const newContent = serializeFrontmatter(updated, body);
      await writeFile(filepath, newContent, 'utf8');
      console.log(`[ok] ${filename} — frontmatter updated to published: true`);
      anyPublished = true;
    } else {
      console.warn(`[warn] ${filename} — not fully published on both platforms; frontmatter NOT updated`);
    }
  }

  await savePublishLog(log);

  if (anyFailed) {
    console.error('\nOne or more articles failed to publish. See errors above.');
    process.exit(1);
  }

  if (!anyPublished) {
    console.log('\nNo new articles to publish — all up to date.');
  } else {
    console.log('\nDone. All new articles published successfully.');
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
