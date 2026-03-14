# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This is my personal website.
I want it to be simple, both in terms of the code and the layout and style.
The idea was to use a static site generator and directly style in CSS, although with the use of tailwind.
This website is to serve in part as a CV, listing my work experiences and publications.
However, it is also a place to write about topics I find interesting, to showcase some of my photography, and to host other miscellaneous things.

## Commands

- `hugo serve` — start local dev server with live reload
- `hugo` — build static site to `public/`
- Deploy: commit changes to `public/` submodule, then run `./deploy.sh` (which runs `git submodule foreach --recursive 'git push'`)

Tailwind is present (`tailwind.config.js`) but not yet integrated into the build — currently no npm scripts exist.

## Architecture

This is a **Hugo static site** for Alexander Cumberworth's personal website, deployed to GitHub Pages via a git submodule.

### Deployment model
`public/` is a git submodule pointing to `cumberworth.github.io`. Building the site updates `public/`, which is then pushed separately as the GitHub Pages source.

### Data-driven content
Structured data lives in `data/` as TOML files:
- `data/publications.toml` — academic papers (9+ entries) with fields: title, authors, journal, year, doi, etc.
- `data/experience.toml` — career history
- `data/education.toml` — education history

Templates consume this data via Hugo's `.Site.Data` variable rather than content markdown files.

### Layout structure
- `layouts/baseof.html` — base template with nav (Home, Experience, Publications, Blog, Photography, Contact) and footer
- `layouts/index.html` — homepage
- `layouts/_default/` — single and list templates
- `layouts/publications/` — specialized publication list/single templates
- `layouts/partials/article.html` — reusable academic citation renderer

### Content
`content/` uses Hugo sections (`contact/`, `experience/`, `blog/`, `publications/`) with `_index.md` files.

### Config
`hugo.toml` sets the base URL (`http://cumberworth.org/`), site title, and nav menu items.
