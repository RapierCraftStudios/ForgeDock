import { defineConfig } from 'vitepress'

// Deploy base path for GitHub Pages. This is the single source of truth for the
// `/ForgeDock/` path segment — SITE_HOSTNAME below derives from it instead of
// hardcoding the same segment a second time, so the two can never drift apart
// if this ever changes (custom domain, repo rename). (Ref: forge#2141)
const BASE_PATH = '/ForgeDock/'

// Canonical hostname for the deployed GitHub Pages site. Shared by `sitemap.hostname`
// and the per-page canonical/og:url logic in `transformHead` below so the two can never
// drift apart (see FORGE:ARCHITECT — hostname drift was the #1 risk flagged for this file).
const SITE_HOSTNAME = `https://rapiercraftstudios.github.io${BASE_PATH}`
const SOCIAL_IMAGE = 'https://avatars.githubusercontent.com/in/4051319?s=400'

export default defineConfig({
  title: 'ForgeDock',
  description: 'Autonomous AI development pipeline that uses GitHub as a structured knowledge graph for Claude Code agents.',
  lang: 'en-US',

  // Deploy to GitHub Pages at /
  base: BASE_PATH,

  // Emits sitemap.xml at build time, listing every page under SITE_HOSTNAME.
  sitemap: {
    hostname: SITE_HOSTNAME,
  },

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#7C3AED' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'ForgeDock' }],
    ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
  ],

  // Per-page canonical URL + og/twitter tags derived from each page's own resolved
  // title/description (VitePress already resolves these from frontmatter), plus a
  // JSON-LD SoftwareApplication block on the landing page only.
  transformHead({ page, title, description, siteConfig }) {
    // `page` is the source-relative path (e.g. "index.md", "getting-started.md").
    // Map it to the deployed URL path, respecting `base` and VitePress's clean-URL
    // output (index.md -> root, foo.md -> foo.html). Index pages at any depth
    // (e.g. a future "guide/index.md") map to their directory route ("guide/"),
    // not a literal "guide/index.html" — VitePress serves nested index pages at
    // the directory URL, so the flat `.html` suffix would be wrong for those.
    // (Ref: forge#2142 — flat-page assumption flagged as a review finding on #2139)
    const routePath = page.endsWith('/index.md')
      ? page.slice(0, -'index.md'.length)
      : page === 'index.md'
        ? ''
        : page.replace(/\.md$/, '.html')
    const canonicalUrl = `${SITE_HOSTNAME}${routePath}`

    const head = [
      ['link', { rel: 'canonical', href: canonicalUrl }],
      ['meta', { property: 'og:url', content: canonicalUrl }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    ]

    // WIRE:PROVEN — verified via `npm run docs:build`: the JSON-LD block appears
    // exactly once in dist/index.html and zero times in dist/getting-started.html
    // (and by extension every other built page, since none matches 'index.md').
    if (page === 'index.md') {
      head.push([
        'script',
        { type: 'application/ld+json' },
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: siteConfig.site.title,
          description: siteConfig.site.description,
          url: SITE_HOSTNAME,
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Cross-platform',
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
          },
        }),
      ])
    }

    return head
  },

  themeConfig: {
    logo: 'https://avatars.githubusercontent.com/in/4051319?s=40',
    siteTitle: 'ForgeDock',

    nav: [
      { text: 'Quick Start', link: '/getting-started' },
      { text: 'Commands', link: '/command-reference' },
      { text: 'Annotations', link: '/annotations-explained' },
      {
        text: 'GitHub',
        link: 'https://github.com/RapierCraftStudios/ForgeDock',
      },
    ],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quick Start', link: '/getting-started' },
          { text: 'How It Works', link: '/how-it-works' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Command Reference', link: '/command-reference' },
          { text: 'Command Learning Path', link: '/command-learning-path' },
          { text: 'FORGE Annotation Protocol', link: '/forge-annotation-protocol' },
          { text: 'Annotations Explained', link: '/annotations-explained' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'ForgeDock vs. Manual Workflows', link: '/vs-manual-workflows' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/RapierCraftStudios/ForgeDock' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/forgedock' },
    ],

    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: 'Copyright © 2024–2026 RapierCraft Studios',
    },

    editLink: {
      pattern: 'https://github.com/RapierCraftStudios/ForgeDock/edit/main/docs/site/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
    },
  },

  markdown: {
    lineNumbers: false,
  },
})
