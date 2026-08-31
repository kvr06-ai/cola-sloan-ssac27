#!/usr/bin/env python3
"""Word count for the SSAC27 abstract against the under-500 cap.

SSAC counts title and body. Tables are allowed separately (at most two tables
and figures combined), so table contents and captions are excluded here.

Usage: python3 wordcount_abstract.py [ssac27-abstract.tex]
"""

import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "ssac27-abstract.tex"
src = open(path, encoding="utf-8").read()

# Body only.
src = src.split(r"\begin{document}")[1].split(r"\end{document}")[0]

# Drop comments, then table content and captions (allowed outside the word count).
# Tables are typeset inline rather than as floats, so strip the tabular bodies and
# the minipage caption blocks directly.
src = re.sub(r"(?m)^\s*%.*$", "", src)
src = re.sub(r"\\begin\{table\}.*?\\end\{table\}", "", src, flags=re.S)
src = re.sub(r"\\begin\{tabular\}.*?\\end\{tabular\}", "", src, flags=re.S)
src = re.sub(r"\\begin\{minipage\}.*?\\end\{minipage\}", "", src, flags=re.S)

# Title and track line count toward the total; the repo URL does not read as prose.
src = re.sub(r"\\url\{[^}]*\}", "", src)

# Strip markup, keeping the words inside braces.
src = re.sub(r"\\(section|LARGE|normalsize|small|bfseries|textbf|textit|emph|vspace|hspace)\b", " ", src)
src = re.sub(r"\\begin\{[^}]*\}|\\end\{[^}]*\}", " ", src)
src = re.sub(r"\\\\\[[^\]]*\]|\\\\", " ", src)
src = re.sub(r"\\[a-zA-Z]+\*?", " ", src)
src = src.replace("{", " ").replace("}", " ")
src = src.replace("$", " ").replace("~", " ")
src = re.sub(r"14\{?,?\}?000|14,004", "14004", src)

words = [w for w in src.split() if re.search(r"[A-Za-z0-9]", w)]
n = len(words)
print(f"{n} words (title + body, tables excluded)")
print(f"cap 500, margin {500 - n}")
if n >= 500:
    sys.exit(1)
