#!/usr/bin/env python3
from pathlib import Path

path = Path('src/app/ProductApp.jsx')
source = path.read_text()
old = """                  onBeforeInput={(event) => {
          if (busy || answered) event.preventDefault();
        }}
        onChange={(event) => {
          if (!busy && !answered) setAnswer(event.target.value);
        }}
"""
new = """                  onBeforeInput={(event) => {
                    if (busy || answered) event.preventDefault();
                  }}
                  onChange={(event) => {
                    if (!busy && !answered) setAnswer(event.target.value);
                  }}
"""
count = source.count(old)
if count != 1:
    raise SystemExit(f'expected one visible-field indentation block, found {count}')
path.write_text(source.replace(old, new, 1))
