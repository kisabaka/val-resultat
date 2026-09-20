---
name: coding-style
description: >-
  General writing rules for all code, comments, docstrings, docs, commit messages and replies
  in this repo, in every language (JS, Python, CSS, HTML, Markdown). Load before writing or
  editing any file. Covers Simplified Technical English, no botsplaining, natural line breaks
  under 104 columns, and no em dashes or emojis. The python-style skill adds Python rules on top.
---

# Coding style for this repo

These rules apply to everything you write here:
code, comments, docstrings, README and other docs, commit messages, and your replies to the user.
Language-specific skills (python-style) add to them.

## 1. Write in Simplified Technical English (ASD-STE100)

All English text in code, comments and docs follows ASD-STE100.
Text in another language (the Swedish UI copy, for example) is exempt.
The rules that matter most:

- Keep sentences short. Procedural sentences have at most 20 words, descriptive sentences at most 25.
- One topic per sentence, one instruction per sentence.
- Use the active voice. "The script writes the file", not "the file is written by the script".
- Use the present tense for descriptions and the imperative for instructions.
  "Run the script", not "you should run the script" or "the script should be run".
- Use one word for one meaning, and the same word every time. Do not alternate between
  "district", "area" and "polygon" for the same thing.
- Use the articles "a", "an" and "the". Telegram style ("fetch results from server") is not STE.
- Do not chain more than three nouns. "Election district result file" becomes
  "the result file for an election district".
- Avoid gerunds and -ing forms when a simple verb works. "The parser rejects" rather than
  "the parser is rejecting"; "to build" rather than "for building".
- Prefer plain, approved words: use, start, stop, remove, make sure. Not utilise, initiate,
  terminate, eliminate, ensure.
- Do not use slang, idioms or humour in comments and docs.

STE is about clarity, not stiffness.
If a sentence reads like a manual for a jet engine, it is probably right.

## 2. No botsplaining

Comments and docstrings exist to say what the code cannot.
Delete any that only restate the code.

```python
# Bad: repeats the signature
def load_results(path):
    """Loads results from the given path.

    Args:
        path: the path to load results from.
    Returns:
        the loaded results.
    """

# Good: says what the reader cannot see in the code
def load_results(path):
    """Read a results file written by fetch_results.py.

    Vote counts are per party in the order of the "parties" list. The 314 uppsamlingsdistrikt
    have no geometry and appear only in the kommun totals.
    """
```

Concretely:

- Do not write "This function ..." or "This module ..." openers.
- Do not describe an obvious parameter. `path: the path` is noise.
- Do not narrate control flow ("loop over the rows", "check if empty", "return the result").
- Do not add a docstring to a three-line private helper whose name already says what it does.
- Do write down the why: a workaround, an external constraint, a non-obvious invariant, a unit,
  a source URL, a format quirk.
- One good comment beats five weak ones. When in doubt, leave it out.

The same applies to replies to the user: answer, do not narrate.

## 3. Break lines like a human

Use semantic line breaks.
Start every sentence on a new line.
Do not fill a paragraph to the column limit and then wrap wherever the counter says.

```text
Bad: filled to the limit, sentences broken wherever the column counter says
    Valkarta is an interactive map of the final result of the Swedish general election (riksdagsvalet)
    on 13 September 2026. It shows the result per municipality (kommun) and per electoral district
    (valdistrikt). The page is static HTML, CSS and JavaScript with d3 and topojson-client. There is no
    framework and no backend. All data is precomputed in `data/`.

Good: one sentence per line
    Valkarta is an interactive map of the final result of the Swedish general election (riksdagsvalet)
    on 13 September 2026.
    It shows the result per municipality (kommun) and per electoral district (valdistrikt).
    The page is static HTML, CSS and JavaScript with d3 and topojson-client.
    There is no framework and no backend. All data is precomputed in `data/`.
```

The rules:

- One sentence per line.
- Two short sentences may share a line when they belong together and the line stays short.
- A sentence longer than 104 characters breaks at a clause boundary (after a comma, before a
  conjunction, before a parenthesis). Never in the middle of a phrase.
- The hard limit is 104 characters per line, for code and prose alike. Do not wrap at 80 or 85.
- Markdown renders the lines as one paragraph, so this costs nothing in the output.

This applies to comments, docstrings, Markdown, commit message bodies and any other prose.
## 4. No em dashes, no emojis

Do not use the em dash (the long dash) anywhere:
not in code, comments, docs, UI copy, commit messages or replies.
Use a comma, a colon, parentheses or a full stop instead.
A hyphen is fine in compound words and ranges (2002-2022).

Do not use emojis anywhere, including commit messages, replies and UI copy.
Unicode symbols that carry meaning in the UI are not emojis and are allowed,
for example a check mark or a cross in a status band, or a multiplication sign on a close button.

## Applying the guide

- Apply these rules to every new file and to every line you touch in an existing file.
- Do not rewrite untouched text to match the guide unless the user asks for it.
- In review, cite the section (for example "coding-style section 2") next to each finding.
