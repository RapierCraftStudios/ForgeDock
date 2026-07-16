import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ForgeDock',
  description: 'Autonomous AI development pipeline that uses GitHub as a structured knowledge graph for Claude Code agents.',
  lang: 'en-US',

  // Deploy to GitHub Pages at /
  base: '/ForgeDock/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#7C3AED' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'ForgeDock' }],
  ],

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
