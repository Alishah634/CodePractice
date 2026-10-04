#!/usr/bin/env python3
"""Practice typing a file in your *real* vim (your own .vimrc, plugins, etc.).

    python3 vimtype.py snippets/binary_search.py          # whole file
    python3 vimtype.py snippets/binary_search.py 10 40    # lines 10-40 only

Opens vim with the reference on the left (read-only) and an empty buffer on the
right, scroll/cursor-bound together. Type it out, then :wqa. You get your time,
WPM and a diff of anything that doesn't match.
"""
import difflib
import os
import shutil
import sys
import tempfile
import time


def norm(text):
    return [line.rstrip() for line in text.replace("\r\n", "\n").rstrip().split("\n")]


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        lines = f.read().replace("\r\n", "\n").rstrip().split("\n")
    start = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    end = int(sys.argv[3]) if len(sys.argv) > 3 else len(lines)
    target = "\n".join(lines[start - 1:end]) + "\n"

    editor = os.environ.get("VIMTYPE_EDITOR") or shutil.which("nvim") and "nvim" or "vim"
    ext = os.path.splitext(path)[1]
    tmp = tempfile.mkdtemp(prefix="vimtype-")
    ref = os.path.join(tmp, "REFERENCE" + ext)
    out = os.path.join(tmp, "practice" + ext)
    with open(ref, "w", encoding="utf-8") as f:
        f.write(target)
    open(out, "w").close()

    t0 = time.time()
    os.system(
        f'{editor} -O "{ref}" "{out}" '
        '-c "wincmd h | setlocal readonly nomodifiable scrollbind cursorbind" '
        '-c "wincmd l | setlocal scrollbind cursorbind" '
        '-c "syncbind"'
    )
    elapsed = time.time() - t0

    with open(out, encoding="utf-8") as f:
        typed = f.read()
    shutil.rmtree(tmp, ignore_errors=True)

    want, got = norm(target), norm(typed)
    chars = len("\n".join(want))
    correct = sum(a == b for a, b in zip(want, got))
    mins = elapsed / 60
    print(f"\nTime: {int(elapsed // 60)}:{int(elapsed % 60):02d}   "
          f"WPM: {round(chars / 5 / mins) if mins else 0}   "
          f"Lines correct: {correct}/{len(want)}")
    if want == got:
        print("Perfect match! 🎉")
    else:
        print("\nDifferences (- reference, + yours):")
        for line in difflib.unified_diff(want, got, "reference", "yours", lineterm="", n=1):
            print(line)


if __name__ == "__main__":
    main()
