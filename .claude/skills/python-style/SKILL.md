---
name: python-style
description: >-
  Python style guide for this repo. Load before writing, editing or reviewing any Python
  (scripts/*.py and anything new). Google Python Style Guide on top of PEP 8, with stricter rules
  on exception handling, nested functions, imports and import aliases.
---

# Python style for this repo

Precedence, highest first:

1. The rules in this file.
2. [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html).
3. [PEP 8](https://peps.python.org/pep-0008/).

Where Google and PEP 8 disagree, Google wins:
Google-style docstrings with `Args:`, `Returns:` and `Raises:` sections, and a 4-space indent.
Lines are at most 104 characters, as coding-style says.

## 1. Catch specific exceptions only

Never write a bare `except:`, `except Exception:` or `except BaseException:`.
Name the exceptions the code can raise and let everything else propagate.

```python
# Bad
try:
    data = json.loads(body)
except Exception:
    return None

# Good
try:
    data = json.loads(body)
except json.JSONDecodeError as e:
    print(f"bad json from {url}: {e}", file=sys.stderr)
    return None
```

If you do not know which exception a call raises, find out (docs, source, or run it).
Do not widen the clause.
Retry loops around network or subprocess calls catch `OSError`, `subprocess.CalledProcessError`
and `json.JSONDecodeError` individually.
A `# noqa` comment is not a licence to catch `Exception`.

## 2. No functions inside functions

Do not define a `def` or a `class` inside another function.
Move helpers to module level and pass what they need as parameters.
A small lambda passed directly as an argument (`key=lambda r: r[1]`) is fine.
A nested `def` is not.

```python
# Bad
def main():
    def fetch(path):
        ...
    with ThreadPoolExecutor() as ex:
        ex.map(fetch, paths)

# Good
def fetch(path, base_url, cache_dir):
    ...

def main():
    with ThreadPoolExecutor() as ex:
        ex.map(functools.partial(fetch, base_url=BASE, cache_dir=RAW), paths)
```

A closure that exists only to capture local state becomes parameters, `functools.partial`
or a small class.

## 3. Import modules, not symbols

Import the module and qualify names at the point of use.
This keeps the origin of every name visible and avoids collisions.

```python
# Bad
from obscure_module.submodule import foo, bar
from shapely.ops import transform, unary_union

# Good
import shapely.ops
...
shapely.ops.unary_union(parts)
```

Exception: you may import a symbol directly from a **well-known** module
when the symbol is at least as recognisable as the module.
Examples: `from collections.abc import Callable`, `from dataclasses import dataclass`,
`from pathlib import Path`, `from typing import Any`,
`from concurrent.futures import ThreadPoolExecutor`.
The test: a reader who has never seen this file knows immediately where the name comes from.
Symbols from third-party or project modules fail that test.

## 4. Import aliases only to resolve a real collision

`import x as y` is allowed only when the module name collides with a public identifier
in the importing file, and that identifier cannot reasonably be renamed.
Never alias for brevity or by convention.

```python
# Bad
import numpy as np
import topojson as tp

# Good
import numpy
import topojson
...
numpy.asarray(values)
```

If the alias is necessary, say why in a comment on the import line.

## 5. Everything else: Google style

The points that most often need a reminder:

- Module and function docstrings in Google format for anything public or non-trivial: a one-line
  summary, then `Args:`, `Returns:` and `Raises:` as applicable. See coding-style section 2 for
  what not to write in them.
- `snake_case` functions and variables, `CAPS` module constants, `CapWords` classes.
- Imports grouped stdlib, third-party, local; alphabetised within groups; one module per line.
- Prefer explicit over implicit: no wildcard imports, no mutable default arguments, no `global`
  unless the module is a deliberate singleton.
- Scripts guard their entry point with `if __name__ == "__main__": main()`.
- Type annotations on public function signatures where they aid reading. Do not annotate obvious
  locals.

## Applying the guide

- New Python must follow all five sections before it is done.
- When you edit an existing file, fix violations in the code you touch. Do not reformat unrelated
  code in the same change unless asked.
- In review, cite the section (for example "python-style section 1") next to each finding.
