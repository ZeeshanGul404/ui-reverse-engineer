# UI Reverse Engineer

A local developer tool that inspects publicly accessible websites and presents design tokens and a navigable view of their parsed HTML structure.

## Features

- Extracts colors, font families and sizes, spacing values, border radii, shadows, and layout declarations from embedded, inline, and accessible external CSS.
- Displays an interactive DOM tree with filters for headings, links, buttons, images, forms and inputs, and semantic elements.
- Shows relevant attributes, text, nesting depth, child count, link destination, and image source when an element is selected.
- Lets you copy colors and generated CSS values from the design inspector.
- Restricts analysis requests to public HTTP(S) hosts, validates each redirect, pins requests to checked DNS results, and limits response size, stylesheet count, node count, nesting depth, and request time.

The analyzer parses the fetched HTML and CSS; it does not execute website scripts, bypass access controls, fetch arbitrary URLs found in page attributes, or recover original source code or hidden application logic. Dynamically rendered content and blocked stylesheets may not be included.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```powershell
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000/) in your browser. Submit a public website URL to run the design analysis and populate the Structure Explorer.

## API

- `POST /api/analyze` — accepts JSON `{ "url": "https://example.com" }` and returns page details and extracted design tokens.
- `POST /api/structure` — accepts the same JSON shape and returns a bounded tree of parsed HTML elements and relevant attributes.

Both endpoints use the same public-URL validation and safe-fetching logic.

## Project structure

```text
public/
  index.html   Dashboard markup
  script.js    Browser-side rendering, filters, and interactions
  style.css    Dashboard styles
server.js      Express API, safe fetching, HTML/CSS parsing
```
