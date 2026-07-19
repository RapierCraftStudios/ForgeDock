import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mineContext } from './contextpack.mjs';

const ISSUE_JSON = JSON.stringify({
  number: 2701,
  title: 'feat(engine): deterministic GitHub context miner',
  body: '## Problem\n\nSome problem text.',
  labels: [{ name: 'priority:P1' }, { name: 'improvement' }],
  state: 'OPEN',
  milestone: { title: 'engine-v2-harness' },
});

/** Build a mocked `io` that routes `gh` calls by command prefix, mirroring
 * the `ioFor({...})` convention in `bin/tests/engine-phases.test.mjs`. */
function ioFor({ issueView = ISSUE_JSON, comments = '[]', timeline = '[]', prListById = {}, gistById = {} } = {}) {
  return {
    gh: async (args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('issue view')) return issueView;
      if (cmd.includes('/comments')) return comments;
      if (cmd.includes('/timeline')) return timeline;
      if (cmd.startsWith('issue list')) {
        // args: issue list --label review-finding --search "#N in:body" ...
        const searchIdx = args.indexOf('--search');
        const search = searchIdx >= 0 ? args[searchIdx + 1] : '';
        const prMatch = /^#(\d+)/.exec(search || '');
        const pr = prMatch ? prMatch[1] : null;
        return prListById[pr] !== undefined ? prListById[pr] : '[]';
      }
      if (cmd.startsWith('gist view')) {
        const gistId = args[2];
        if (gistById[gistId] && gistById[gistId].error) throw new Error(gistById[gistId].error);
        return gistById[gistId] !== undefined ? gistById[gistId] : '';
      }
      throw new Error(`unexpected gh call: ${cmd}`);
    },
  };
}

describe('mineContext — io guard', () => {
  it('throws TypeError when io.gh is missing', async () => {
    await assert.rejects(() => mineContext(1, {}), TypeError);
  });

  it('throws TypeError when io.gh is not a function', async () => {
    await assert.rejects(() => mineContext(1, { io: { gh: 'nope' } }), TypeError);
  });
});

describe('mineContext — empty issue (no comments)', () => {
  it('returns issue core with empty comments/annotations/affectedFiles/linkedPrs/gists', async () => {
    const io = ioFor({});
    const result = await mineContext(2701, { io });

    assert.equal(result.issue.ok, true);
    assert.equal(result.issue.number, 2701);
    assert.equal(result.issue.title, 'feat(engine): deterministic GitHub context miner');
    assert.deepEqual(result.comments, []);
    assert.deepEqual(result.annotations, []);
    assert.deepEqual(result.affectedFiles, []);
    assert.deepEqual(result.linkedPrs, []);
    assert.deepEqual(result.gists, []);
    assert.equal(result.meta.commentCount, 0);
    assert.equal(result.meta.issueNumber, 2701);
  });

  it('does not throw and does not fabricate an issue when gh issue view fails', async () => {
    const io = {
      gh: async (args) => {
        if (args.join(' ').startsWith('issue view')) throw new Error('gh: issue not found');
        return '[]';
      },
    };
    const result = await mineContext(9999, { io });
    assert.equal(result.issue.ok, false);
    assert.ok(result.issue.error);
  });
});

describe('mineContext — issue with FORGE annotation types present', () => {
  const contractBody = [
    '<!-- FORGE:CONTRACT -->',
    '## Builder Contract',
    '',
    '**Task type**: Backend Feature',
    '',
    '### Deliverables',
    '| File | Change | Why |',
    '|------|--------|-----|',
    '| `bin/engine/contextpack.mjs` | New | Core miner |',
    '',
    '### Affected Files',
    '1. `bin/engine/contextpack.mjs` (new) — exports mineContext()',
    '2. `bin/engine/contextpack.mine.test.mjs` (new) — unit tests',
    '',
    '### Out of Scope',
    'Everything else.',
  ].join('\n');

  const investigatorBody = [
    '<!-- FORGE:INVESTIGATOR -->',
    '## Investigation Report',
    '',
    '**Verdict**: CONFIRMED',
    '**Confidence**: HIGH',
    '**Severity**: MEDIUM',
    '**Task Type**: Feature',
    '**Decomposition Assessment**: NO',
    '',
    '## Affected Files',
    '- `packages/protocol/src/phases.js` — read-only import',
    '',
    '<!-- INVESTIGATION:COMPLETE -->',
  ].join('\n');

  const otherAnnotationsBody = [
    '<!-- FORGE:CONTEXT -->',
    '## Implementation Context',
    'Some context.',
    '<!-- FORGE:CONTEXT:COMPLETE -->',
    '',
    '<!-- FORGE:ARCHITECT -->',
    '## Implementation Plan',
    'Some plan.',
    '<!-- FORGE:ARCHITECT:COMPLETE -->',
    '',
    '<!-- FORGE:BUILDER -->',
    '## Implementation Complete',
    '**Branch**: `feat/x-1`',
    '**Commits**: abc123',
    '**Files changed**: 2',
    '<!-- FORGE:BUILDER:COMPLETE -->',
    '',
    '<!-- FORGE:REVIEWER -->',
    '**Verdict**: APPROVED',
    '',
    '<!-- FORGE:TRAJECTORY -->',
    '## Pipeline Trajectory',
    'Some trajectory.',
    '',
    '<!-- FORGE:KNOWLEDGE_GIST: https://gist.github.com/exampleuser/abc123def456 -->',
    '<!-- FORGE:MILESTONE_INDEX: https://gist.github.com/exampleuser/milestone789 -->',
  ].join('\n');

  const comments = JSON.stringify([
    { id: 1, author: 'agent-bot', body: contractBody, createdAt: '2026-01-01T00:00:00Z' },
    { id: 2, author: 'agent-bot', body: investigatorBody, createdAt: '2026-01-01T00:05:00Z' },
    { id: 3, author: 'agent-bot', body: otherAnnotationsBody, createdAt: '2026-01-01T00:10:00Z' },
  ]);

  it('parses every FORGE annotation type via packages/protocol parse(), not inline regex', async () => {
    const io = ioFor({ comments });
    const result = await mineContext(2701, { io });

    const types = result.annotations.map((a) => a.type).sort();
    assert.deepEqual(types, [
      'ARCHITECT',
      'BUILDER',
      'CONTEXT',
      'CONTRACT',
      'INVESTIGATOR',
      'KNOWLEDGE_GIST',
      'MILESTONE_INDEX',
      'REVIEWER',
      'TRAJECTORY',
    ]);
  });

  it('scopes annotations to the comment that posted them (commentIndex/commentId)', async () => {
    const io = ioFor({ comments });
    const result = await mineContext(2701, { io });

    const contract = result.annotations.find((a) => a.type === 'CONTRACT');
    const investigator = result.annotations.find((a) => a.type === 'INVESTIGATOR');
    assert.equal(contract.commentId, 1);
    assert.equal(investigator.commentId, 2);
  });

  it('populates comment.author/comment.createdAt from the post-jq gh output shape', async () => {
    // fetchAllComments()'s --jq filter already transforms the raw GitHub API
    // shape ({user:{login}, created_at}) into {author, createdAt} before this
    // module ever sees it — the mock IS standing in for gh + --jq together, so
    // the fixture above uses the POST-jq field names. This test exists so a
    // fixture regression back to the raw shape (author: "", createdAt: null)
    // fails loudly instead of silently — see forge review-finding SPEC-5.
    const io = ioFor({ comments });
    const result = await mineContext(2701, { io });

    assert.equal(result.comments.length, 3);
    assert.equal(result.comments[0].author, 'agent-bot');
    assert.equal(result.comments[0].createdAt, '2026-01-01T00:00:00Z');
    for (const c of result.comments) {
      assert.notEqual(c.author, '');
      assert.notEqual(c.createdAt, null);
    }
  });

  it('merges affected files from CONTRACT and INVESTIGATOR annotations, deduplicated', async () => {
    const io = ioFor({ comments });
    const result = await mineContext(2701, { io });

    assert.deepEqual(result.affectedFiles, [
      'bin/engine/contextpack.mjs',
      'bin/engine/contextpack.mine.test.mjs',
      'packages/protocol/src/phases.js',
    ]);
  });

  it('resolves gist URLs from KNOWLEDGE_GIST/MILESTONE_INDEX inline values and fetches content', async () => {
    const io = ioFor({
      comments,
      gistById: {
        abc123def456: 'gist content for knowledge gist',
        milestone789: 'gist content for milestone index',
      },
    });
    const result = await mineContext(2701, { io });

    assert.equal(result.gists.length, 2);
    const byUrl = Object.fromEntries(result.gists.map((g) => [g.url, g]));
    assert.equal(byUrl['https://gist.github.com/exampleuser/abc123def456'].available, true);
    assert.equal(byUrl['https://gist.github.com/exampleuser/abc123def456'].content, 'gist content for knowledge gist');
    assert.equal(byUrl['https://gist.github.com/exampleuser/milestone789'].available, true);
  });
});

describe('mineContext — deleted/missing gist handling', () => {
  it('marks an unfetchable gist unavailable instead of throwing', async () => {
    const gistBody = '<!-- FORGE:KNOWLEDGE_GIST: https://gist.github.com/exampleuser/deadbeef -->';
    const comments = JSON.stringify([
      { id: 1, author: 'agent-bot', body: gistBody, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const io = ioFor({
      comments,
      gistById: { deadbeef: { error: 'gist not found (404)' } },
    });

    const result = await mineContext(2701, { io });
    assert.equal(result.gists.length, 1);
    assert.equal(result.gists[0].available, false);
    assert.ok(result.gists[0].error);
    assert.equal(result.gists[0].content, null);
  });

  it('marks a malformed gist URL unavailable without ever calling gh gist view', async () => {
    const gistBody = '<!-- FORGE:PRIOR_GIST: not-a-real-url -->';
    const comments = JSON.stringify([
      { id: 1, author: 'agent-bot', body: gistBody, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    let gistViewCalled = false;
    const io = {
      gh: async (args) => {
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) return comments;
        if (cmd.includes('/timeline')) return '[]';
        if (cmd.startsWith('gist view')) {
          gistViewCalled = true;
          return '';
        }
        throw new Error(`unexpected gh call: ${cmd}`);
      },
    };

    const result = await mineContext(2701, { io });
    assert.equal(result.gists.length, 1);
    assert.equal(result.gists[0].available, false);
    assert.equal(gistViewCalled, false);
  });
});

describe('mineContext — pagination for >100 comments', () => {
  it('walks every page and returns all comments, not just the first page', async () => {
    // Simulate gh api --paginate --jq output: one JSON array literal per
    // page, concatenated back-to-back (see fetchAllComments()'s docblock).
    const page1 = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        author: 'agent-bot',
        body: `comment ${i + 1}`,
        createdAt: '2026-01-01T00:00:00Z',
      })),
    );
    const page2 = JSON.stringify(
      Array.from({ length: 37 }, (_, i) => ({
        id: 101 + i,
        author: 'agent-bot',
        body: `comment ${101 + i}`,
        createdAt: '2026-01-01T00:00:00Z',
      })),
    );
    const paginatedOutput = `${page1}\n${page2}`;

    const io = ioFor({ comments: paginatedOutput });
    const result = await mineContext(2701, { io });

    assert.equal(result.comments.length, 137);
    assert.equal(result.meta.commentCount, 137);
    assert.equal(result.comments[0].body, 'comment 1');
    assert.equal(result.comments[136].body, 'comment 137');
  });

  it('skips an unparseable page without dropping the other pages', async () => {
    const page1 = JSON.stringify([{ id: 1, author: 'a', body: 'ok', createdAt: 't' }]);
    const badPage = 'not json';
    const page3 = JSON.stringify([{ id: 3, author: 'a', body: 'also ok', createdAt: 't' }]);
    const io = ioFor({ comments: `${page1}\n${badPage}\n${page3}` });

    const result = await mineContext(2701, { io });
    assert.equal(result.comments.length, 2);
    assert.equal(result.meta.partialParseFailure, true);
  });
});

describe('mineContext — linked PRs and review findings', () => {
  it('resolves linked PRs via the issue timeline (cross-referenced + pull_request), not text matching', async () => {
    // This is what `gh api .../timeline --jq '[.[] | select(...) | select(...) | .source.issue.number]'`
    // would already have returned — the mock stands in for `gh`, not for `jq`,
    // so it returns the post-filter shape (an array of PR numbers, with the
    // "labeled" event and the non-PR #43 cross-reference already excluded by
    // the real jq filter, and #42 appearing twice because the real filter has
    // no built-in dedup — mineContext() itself must dedup).
    const timeline = JSON.stringify([42, 42]);
    const io = ioFor({
      timeline,
      prListById: { 42: JSON.stringify([{ number: 501, title: 'review finding for PR #42' }]) },
    });

    const result = await mineContext(2701, { io });
    assert.equal(result.linkedPrs.length, 1);
    assert.equal(result.linkedPrs[0].number, 42);
    assert.deepEqual(result.linkedPrs[0].reviewFindings, [{ number: 501, title: 'review finding for PR #42' }]);
  });

  it('returns an empty linkedPrs array when the issue has no cross-referenced PRs', async () => {
    const io = ioFor({ timeline: '[]' });
    const result = await mineContext(2701, { io });
    assert.deepEqual(result.linkedPrs, []);
  });
});

describe('mineContext — explicit repo threading (satellite/cross-repo support)', () => {
  it('passes -R {repo} on issue view and issue list calls when repo is provided', async () => {
    const calls = [];
    const io = {
      gh: async (args) => {
        calls.push(args.join(' '));
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) return '[]';
        if (cmd.includes('/timeline')) return '[]';
        return '[]';
      },
    };
    await mineContext(2701, { io, repo: 'RapierCraftStudios/some-satellite' });

    const issueViewCall = calls.find((c) => c.startsWith('issue view'));
    assert.ok(issueViewCall.includes('-R RapierCraftStudios/some-satellite'));
  });

  it('threads repo into the comments/timeline gh api paths instead of the cwd-implicit placeholder', async () => {
    const calls = [];
    const io = {
      gh: async (args) => {
        calls.push(args.join(' '));
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) return '[]';
        if (cmd.includes('/timeline')) return '[]';
        return '[]';
      },
    };
    await mineContext(2701, { io, repo: 'RapierCraftStudios/some-satellite' });

    const commentsCall = calls.find((c) => c.includes('/comments'));
    assert.ok(commentsCall.includes('repos/RapierCraftStudios/some-satellite/issues/2701/comments'));
    assert.ok(!commentsCall.includes('{owner}/{repo}'));
  });
});

describe('mineContext — fetch-failure surfacing (review-finding SPEC-1/SPEC-2/SPEC-3)', () => {
  // A genuine gh fetch failure (auth/rate-limit/network) must never be
  // indistinguishable from a legitimate empty result — comments are the sole
  // annotation source, so a swallowed comments-fetch failure would silently
  // report "no pipeline history" for an issue that actually has extensive
  // history. Each *FetchError field in meta exists to make that distinction
  // observable to a caller instead of collapsing into `[]`/empty.

  it('surfaces a comments-fetch failure via meta.commentsFetchError instead of reporting zero comments silently', async () => {
    const io = {
      gh: async (args) => {
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) throw new Error('gh: rate limit exceeded');
        if (cmd.includes('/timeline')) return '[]';
        return '[]';
      },
    };
    const result = await mineContext(2701, { io });

    assert.deepEqual(result.comments, []);
    assert.ok(result.meta.commentsFetchError);
    assert.match(result.meta.commentsFetchError, /rate limit/);
  });

  it('does not set meta.commentsFetchError for a genuinely empty (zero-comment) issue', async () => {
    const io = ioFor({ comments: '[]' });
    const result = await mineContext(2701, { io });

    assert.deepEqual(result.comments, []);
    assert.equal('commentsFetchError' in result.meta, false);
  });

  it('surfaces a timeline-fetch failure via meta.linkedPrsFetchError instead of reporting zero linked PRs silently', async () => {
    const io = {
      gh: async (args) => {
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) return '[]';
        if (cmd.includes('/timeline')) throw new Error('gh: network error');
        return '[]';
      },
    };
    const result = await mineContext(2701, { io });

    assert.deepEqual(result.linkedPrs, []);
    assert.ok(result.meta.linkedPrsFetchError);
    assert.match(result.meta.linkedPrsFetchError, /network error/);
  });

  it('does not set meta.linkedPrsFetchError when the issue genuinely has no linked PRs', async () => {
    const io = ioFor({ timeline: '[]' });
    const result = await mineContext(2701, { io });

    assert.deepEqual(result.linkedPrs, []);
    assert.equal('linkedPrsFetchError' in result.meta, false);
  });

  it('surfaces a review-findings-fetch failure per PR via meta.reviewFindingsFetchErrors instead of reporting zero findings silently', async () => {
    const io = {
      gh: async (args) => {
        const cmd = args.join(' ');
        if (cmd.startsWith('issue view')) return ISSUE_JSON;
        if (cmd.includes('/comments')) return '[]';
        if (cmd.includes('/timeline')) return JSON.stringify([42]);
        if (cmd.startsWith('issue list')) throw new Error('gh: issue list failed');
        return '[]';
      },
    };
    const result = await mineContext(2701, { io });

    assert.equal(result.linkedPrs.length, 1);
    assert.equal(result.linkedPrs[0].number, 42);
    assert.deepEqual(result.linkedPrs[0].reviewFindings, []);
    assert.ok(result.meta.reviewFindingsFetchErrors);
    assert.ok(result.meta.reviewFindingsFetchErrors[42]);
    assert.match(result.meta.reviewFindingsFetchErrors[42], /issue list failed/);
  });
});

describe('mineContext — no inline FORGE marker literals (structural check)', () => {
  it('the module source contains no "FORGE:" reference outside comments — parsing goes through packages/protocol', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./contextpack.mjs', import.meta.url)), 'utf8');
    // "FORGE:" may appear freely in docblocks/comments describing the
    // convention (e.g. "no inline <!-- FORGE:X --> marker regex literals").
    // It must NEVER appear in executable code (a regex/string literal that
    // would actually match a marker at runtime) — strip every /** */ block
    // comment and // line comment first, then require zero "FORGE:"
    // occurrences in what remains.
    const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutLineComments = withoutBlockComments
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.equal(withoutLineComments.includes('FORGE:'), false);
  });
});
