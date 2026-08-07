---
name: html-that
description: Render assistant content as Markdown in a self-contained temporary HTML reading page and open it in the default browser. Use when the user says `/html`, `/html that`, gives `/html` a contextual scope such as `only the table`, supplies particular content to render, asks to view the last assistant answer in a minimal Firefox Reader-style page, or explicitly invokes `$html-that`.
---

# HTML That

Open the last assistant answer as a quiet, readable local web page with no chat chrome.

## Select the content

1. Read the current `/html` request for an explicit or contextual selection.
2. If the user supplies content in the current request, render that content.
3. If the user identifies a portion of the preceding answer, such as `/html only the table`, `/html the example`, or `/html from “Architecture” onward`, render exactly that portion in its original order.
4. Otherwise, for bare `/html`, `/html that`, or any request without a clear narrower scope, render the entire most recent user-visible assistant response before the current user message.
5. Prefer the assistant's `final` response. Exclude commentary, status updates, tool calls, tool output, hidden reasoning, and system or developer instructions.
6. Exclude the `/html` instruction itself and earlier user prompts unless the user explicitly supplies or selects them as content.
7. If no source content exists, stop and explain that there is nothing to render.

Resolve references such as `that`, `the table`, `the second example`, or a quoted phrase from the visible conversation. Do not narrow the content based on a guess: when the request has no unambiguous selection, use the whole preceding assistant response. Treat `/html` and its selection words as instructions, not page content.

## Capture the question

Find the substantive user request that directly led to the selected assistant answer. Skip `/html` commands and later feedback about the rendering itself. Write one short, cleaned-up question that preserves the user's intent: correct obvious spelling and grammar, remove conversational filler, and retain important scope or constraints. Do not add requirements, resolve ambiguity, or turn a statement into a question if it was not one. If the original request is already concise and clear, use it verbatim.

## Build the page

1. Resolve `assets/reader.html` relative to this `SKILL.md`.
2. Create a unique temporary directory with `mktemp -d /tmp/codex-html-that.XXXXXX`.
3. Copy `assets/reader.html` to `<temporary-directory>/index.html`.
4. When the current directory is inside a Git repository, use `git rev-parse --show-toplevel` and show its directory name as a single, visually secondary repository line. Outside a Git repository, omit this line.
5. Use `apply_patch` to replace exactly `<!-- HTML_THAT_CONTENT -->` in the copied file with a compact repository and question-and-answer structure:

   ```html
   <p class="repository">Repository: <code>[repository name]</code></p>
   <section class="question" aria-labelledby="question-label">
     <p class="section-label" id="question-label">Question</p>
     <p>[cleaned-up user question]</p>
   </section>
   <section class="answer" aria-labelledby="answer-label">
     <p class="section-label" id="answer-label">Answer</p>
     [semantic HTML for the selected assistant response]
   </section>
   ```

Keep the repository line and question minimal and visually secondary. The answer remains the main content and retains its original wording and order.

Render the selected content's Markdown into semantic HTML. Preserve its wording, order, code, links, citations, headings, lists, tables, and emphasis without summarizing, correcting, expanding, or labeling it. Do not show literal Markdown punctuation when it represents formatting. A response containing only `Paris` becomes `<p>Paris</p>`; `**Paris**` becomes `<p><strong>Paris</strong></p>`.

### Local code links

The page lives in a temporary directory, so repository-relative Markdown links would otherwise resolve beside `index.html` and break. Resolve each link before rendering:

- Keep `http:` and `https:` links as ordinary web links, with `target="_blank" rel="noopener noreferrer"`.
- For a link that refers to an existing local source file, resolve a relative target against the current workspace directory. An absolute target is already a filesystem path. Recognize the optional Codex location suffix `:line` or `:line:column` after the file path.
- Render a resolved local source link as a VS Code deep link: `vscode://file/<absolute-path>:line:column`. URL-encode path characters as needed, preserve path separators and the optional location suffix, and omit a missing line or column. This lets the browser hand the link to VS Code instead of trying to navigate relative to the temporary HTML page.
- If a relative link does not resolve to an existing local file, retain it as an ordinary relative link rather than inventing a destination.

Keep the document safe and self-contained:

- Escape raw HTML from the response before representing its intended visible content.
- Do not add scripts, event-handler attributes, forms, iframes, remote styles, remote fonts, or embedded remote media.
- Reject `javascript:` and other executable URLs. The only non-web protocol allowed for a verified local source file is the `vscode:` link described above.
- Keep the template's existing `<style>` block and document structure unchanged except for replacing the content marker.

## Open and report

1. Verify that `index.html` exists, is non-empty, and no longer contains `HTML_THAT_CONTENT`.
2. Open the file in the default browser with `open <absolute-path>` on macOS. Use `xdg-open` on Linux or the platform's equivalent elsewhere.
3. Return a concise confirmation with the absolute path to the temporary HTML file.

If the browser opener fails, keep the HTML file and return its path with the failure reason.
