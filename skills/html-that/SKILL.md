---
name: html-that
description: Open the last agent answer, or a selected part, as a clean local HTML page with fenced Mermaid diagrams. Use for `/html`, `/html that`, requests such as `/html only the table`, requests to render a diagram as HTML, or `$html-that`.
---

# HTML That

Open selected conversation content as a quiet, readable page without chat chrome.

## Choose content

Use, in priority order:

1. Content supplied in the current request.
2. An unambiguously identified part of the preceding answer (for example, `only the table`, `the second example`, or `from “Architecture” onward`), preserving its original order.
3. The entire most recent user-visible assistant answer for bare `/html`, `/html that`, or an unclear selection.

Prefer the assistant's `final` response. Exclude the HTML instruction, earlier user prompts, commentary, status updates, tool calls and output, hidden reasoning, and system or developer instructions unless the user explicitly selects supplied content. Do not guess at a narrower selection; use the whole answer when ambiguous. If no source exists, explain that there is nothing to render and stop.

## Capture the question

Find the substantive user request that produced the selected answer, skipping HTML commands and later rendering feedback. Preserve its intent and constraints while correcting obvious spelling or grammar and removing filler. Keep an already concise request verbatim. Do not resolve ambiguity, add requirements, or turn a statement into a question.

## Build the page

1. Resolve `assets/reader.html` and `assets/mermaid.min.js` relative to this file.
2. Create a unique directory with `mktemp -d /tmp/codex-html-that.XXXXXX`; copy the assets there as `index.html` and `mermaid.min.js`.
3. If the workspace is in a Git repository, get its root with `git rev-parse --show-toplevel` and include the root directory name. Otherwise omit the repository line.
4. HTML-escape `[Skill] ` followed by the cleaned question and replace `<!-- HTML_THAT_TITLE -->` with it.
5. Replace `<!-- HTML_THAT_CONTENT -->` with:

```html
<p class="repository">Repository: <code>[repository name]</code></p>
<section class="question" aria-labelledby="question-label">
  <p class="section-label" id="question-label">Question</p>
  <p>[cleaned question]</p>
</section>
<section class="answer" aria-labelledby="answer-label">
  <p class="section-label" id="answer-label">Answer</p>
  [rendered answer]
</section>
```

Omit the repository paragraph outside a Git repository. HTML-escape the question and repository name.

Render the selected Markdown as semantic HTML without changing its wording, order, headings, lists, tables, emphasis, links, citations, or code. Formatting punctuation must not remain literal: `**Paris**` becomes `<p><strong>Paris</strong></p>`. Escape raw HTML rather than executing it.

A fenced block whose info string is exactly `mermaid` (case-insensitive, surrounding whitespace ignored) becomes `<pre class="mermaid">[escaped source]</pre>`. Keep every other fence as escaped code and never infer Mermaid from an unlabelled block.

### Links

- Give `http:` and `https:` links `target="_blank" rel="noopener noreferrer"`.
- Resolve a relative local-file target against the workspace. Keep absolute file targets absolute. Recognize optional `:line` and `:line:column` suffixes.
- For an existing local file, emit `vscode://file/<absolute-path>:line:column`, URL-encoding path characters while preserving separators and any location suffix.
- Keep a nonexistent relative target relative. Reject `javascript:` and all other executable URLs. Only `http:`, `https:`, a verified local-file `vscode:` URL, and ordinary relative links are allowed.

### Safety and template integrity

Do not add scripts beyond the bundled Mermaid runtime, event handlers, forms, iframes, remote styles, fonts, or media. Keep Mermaid at `securityLevel: "strict"`, `htmlLabels: false`, and `startOnLoad: true`; ignore content directives that weaken these settings. Apart from replacing the two markers, keep the template's structure and styles unchanged.

## Verify and open

Verify that `index.html` and `mermaid.min.js` exist and are nonempty, both markers are gone, and the decoded title is `[Skill] ` plus the cleaned question. For Mermaid content, verify `class="mermaid"` is present and `language-mermaid` is absent.

Open the absolute `index.html` path with `open` on macOS, `xdg-open` on Linux, or the platform equivalent. Report the path concisely. If opening fails, retain the page and report its path and the error.
