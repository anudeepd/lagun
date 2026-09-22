#!/usr/bin/env python3
"""Regenerate Lagun's bundled-dependency licence notices.

The package set is the production dependency closure of the frontend bundle,
read from ``frontend/package-lock.json``; versions, SPDX identifiers and
licence texts come from the installed packages in ``frontend/node_modules``.
The result is written to ``frontend/public/THIRD_PARTY_LICENSES.txt`` (which
Vite copies into ``lagun/static/``) and mirrored to
``lagun/static/THIRD_PARTY_LICENSES.txt``.

Standard library only, no install step of its own. Run it with
``make licenses``; ``--check`` reports a stale file instead of writing it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import textwrap
from pathlib import Path
from typing import NoReturn

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND = REPO_ROOT / "frontend"
LOCKFILE = FRONTEND / "package-lock.json"
NODE_MODULES = FRONTEND / "node_modules"
BUNDLE_DIR = REPO_ROOT / "lagun" / "static" / "assets"
OUTPUTS = (
    FRONTEND / "public" / "THIRD_PARTY_LICENSES.txt",
    REPO_ROOT / "lagun" / "static" / "THIRD_PARTY_LICENSES.txt",
)

LICENCE_FILE_RE = re.compile(r"^(licen[cs]e|copying|notice)", re.IGNORECASE)
BUNDLE_SUFFIXES = (".js", ".mjs", ".css")

# Spot checks that the committed bundle was built from the versions the
# lockfile resolved: marker text -> the package it proves is inside
# lagun/static/assets/. "{version}" is replaced with the locked version. A
# marker that is missing means the bundle and the lockfile disagree (rebuild
# the frontend); a marker whose package is absent from the closure means the
# bundle contains something the lockfile does not declare.
BUNDLE_MARKERS = {
    "react": "react.production.min.js",
    "react-dom": "react-dom.production.min.js",
    "scheduler": "scheduler.production.min.js",
    "ag-grid-community": '"{version}"',
    "lucide-react": "@license lucide-react v{version} - ISC",
    "zustand": "zustand persist middleware",
    "highlight.js": "highlight.js/issues/",
    "react-syntax-highlighter": "react-syntax-highlighter-line-number",
    "@codemirror/state": "@codemirror/state",
}

# Reproduced from the SPDX licence list, for the packages whose published
# tarball contains no licence file of its own.
CANONICAL_MIT = """\
MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

CANONICAL_CC0 = """\
CC0 1.0 Universal is a public-domain dedication and imposes no attribution
requirement. Its operative statement:

  To the extent possible under law, the author(s) have dedicated all copyright
  and related and neighbouring rights to this software to the public domain
  worldwide. This software is distributed without any warranty.

  Full text: https://creativecommons.org/publicdomain/zero/1.0/legalcode
"""

HEADER = """\
Third-party software bundled with Lagun
=======================================

Lagun itself is MIT licensed (see LICENSE). The published wheel ships a
pre-built JavaScript bundle in lagun/static/assets/, and the notices below
cover every third-party package that bundle is built from.

How this file is generated
--------------------------
Do not edit it by hand; it is overwritten. Regenerate it with

    make licenses            # or: python3 scripts/generate-third-party-licenses.py

from a checkout whose frontend/node_modules is installed
(`cd frontend && npm ci`). The package set is the *production dependency
closure* of the frontend build, computed from frontend/package-lock.json: the
root package's `dependencies` plus every transitive runtime dependency, with
npm's dev-only entries skipped. Versions, SPDX identifiers and licence texts
are read from the installed packages under frontend/node_modules/.

The closure is a superset of what the bundler emits: Rollup tree-shakes
packages that no module imports, and type-only `@types/*` packages ship no
runtime code at all. Listing an installed package that was not emitted is
harmless; omitting an emitted one would not be.

This run: @@TOTAL@@ packages. @@CHECKED@@ of them were positively identified
inside lagun/static/assets/ by name, licence banner or version string, so the
committed bundle and this list were checked against each other instead of being
assumed to agree:

@@MARKERS@@

Vite copies frontend/public/ into lagun/static/ verbatim, so this file is
written to both paths and the two copies must stay byte-identical.

Licence texts are reproduced verbatim from the installed packages. A package
whose published tarball ships no licence file is marked as such and carries the
canonical text for the identifier it declares.


@@PRESERVED@@


Package notices
===============
The production dependency closure of the frontend bundle, alphabetically. Each
entry gives the package, the version frontend/package-lock.json resolved, the
SPDX identifier the package declares and the URL it declares.
"""


# The Motion for React and bundled-font notices are kept verbatim from the
# hand-written file this script replaced, so that regenerating the notices
# never drops attribution that was already published.
PRESERVED_SECTIONS = """\
Motion for React
================

Motion is Copyright (c) 2018 Framer B.V. and contributors.
https://motion.dev/

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Bundled font software
=====================

Inter
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

JetBrains Mono
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

Both font families are licensed under the SIL Open Font License, Version 1.1.

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the Font Software.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
"""


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_closure() -> list[tuple[str, str, str, dict]]:
    """Return (name, version, install directory, lock entry) for every runtime package."""
    if not LOCKFILE.is_file():
        die(f"{LOCKFILE} not found; run this from the repository root")
    lock = json.loads(LOCKFILE.read_text(encoding="utf8"))
    packages = lock["packages"]

    def resolve(parent: str, dep: str) -> str | None:
        """npm resolution: the nearest node_modules directory, then walk up."""
        if parent:
            candidates = [f"{parent}/node_modules/{dep}"]
            current = parent
            while "node_modules/" in current:
                current = current[: current.rfind("node_modules/")].rstrip("/")
                candidates.append(
                    f"{current}/node_modules/{dep}"
                    if current
                    else f"node_modules/{dep}"
                )
        else:
            candidates = [f"node_modules/{dep}"]
        return next((path for path in candidates if path in packages), None)

    closure: dict[str, dict] = {}

    def visit(path: str) -> None:
        if path in closure:
            return
        entry = packages[path]
        closure[path] = entry
        wanted = list(entry.get("dependencies") or {}) + list(
            entry.get("optionalDependencies") or {}
        )
        for dep in entry.get("peerDependencies") or {}:
            if (
                not (entry.get("peerDependenciesMeta") or {})
                .get(dep, {})
                .get("optional")
            ):
                wanted.append(dep)
        for dep in wanted:
            found = resolve(path, dep)
            if found:
                visit(found)

    for dep in packages[""].get("dependencies") or {}:
        found = resolve("", dep)
        if found:
            visit(found)

    result = [
        (
            path.split("node_modules/")[-1],
            str(entry.get("version") or "?"),
            FRONTEND / path,
            entry,
        )
        for path, entry in closure.items()
    ]
    result.sort(key=lambda item: (item[0].lower(), item[1]))
    return result


def read_licence_text(directory: Path) -> str | None:
    """Concatenate every licence/notice file the package ships, or None."""
    if not directory.is_dir():
        return None
    files = sorted(
        (
            child
            for child in directory.iterdir()
            if child.is_file() and LICENCE_FILE_RE.match(child.name)
        ),
        key=lambda child: child.name.lower(),
    )
    blocks = []
    for child in files:
        text = child.read_text(encoding="utf8", errors="replace").strip()
        if not text:
            continue
        blocks.append(text if len(files) == 1 else f"{child.name}:\n\n{text}")
    return "\n\n".join(blocks) if blocks else None


def declared_url(package_json: dict) -> str:
    repository = package_json.get("repository")
    if isinstance(repository, dict):
        repository = repository.get("url")
    candidate = (
        repository if isinstance(repository, str) else package_json.get("homepage")
    )
    if not isinstance(candidate, str) or not candidate:
        return ""
    url = re.sub(r"^git\+", "", candidate.strip())
    url = re.sub(r"^git://", "https://", url)
    url = re.sub(r"^github:", "https://github.com/", url)
    return re.sub(r"\.git$", "", url)


def licence_identifier(package_json: dict) -> str:
    identifier = package_json.get("license")
    if isinstance(identifier, str) and identifier:
        return identifier
    legacy = package_json.get("licenses")
    if isinstance(legacy, list) and legacy:
        first = legacy[0]
        if isinstance(first, dict) and first.get("type"):
            return str(first["type"])
        if isinstance(first, str):
            return first
    return "unknown"


def render_entry(name: str, version: str, directory: Path) -> str:
    package_json = json.loads((directory / "package.json").read_text(encoding="utf8"))
    installed = str(package_json.get("version") or "")
    if installed != version:
        die(
            f"{name}: frontend/node_modules has {installed or 'no version'} but the lockfile "
            f"resolves {version} - run `cd frontend && npm ci`"
        )
    identifier = licence_identifier(package_json)
    heading = f"{name} {version} -- {identifier}"
    url = declared_url(package_json)
    if url:
        heading += f"\n{url}"

    text = read_licence_text(directory)
    if text is None:
        holder = package_json.get("author")
        if isinstance(holder, dict):
            holder = holder.get("name")
        if identifier.upper().startswith("MIT"):
            text = (
                "This package declares MIT in its package.json but its published tarball\n"
                "contains no licence file. The canonical MIT text follows; the copyright\n"
                "holder is the one the package declares.\n\n"
                + CANONICAL_MIT.replace("{holder}", str(holder or name))
            )
        elif identifier.upper().startswith("CC0"):
            text = (
                "This package declares CC0-1.0 in its package.json but its published\n"
                "tarball contains no licence file.\n\n" + CANONICAL_CC0
            )
        else:
            die(
                f"{name}: no licence file found and no canonical text for {identifier!r}"
            )

    rule = "-" * 80
    return f"{rule}\n{heading}\n{rule}\n{text.strip()}\n"


def bundle_text() -> str:
    if not BUNDLE_DIR.is_dir():
        print(
            f"warning: {BUNDLE_DIR} not found; skipping the bundle cross-check",
            file=sys.stderr,
        )
        return ""
    return "\n".join(
        child.read_text(encoding="utf8", errors="replace")
        for child in sorted(BUNDLE_DIR.iterdir())
        if child.is_file() and child.suffix in BUNDLE_SUFFIXES
    )


def verify_bundle(closure: list[tuple[str, str, str, dict]], text: str) -> list[str]:
    """Check each marker against the bundle; return the packages it confirmed."""
    if not text:
        return []
    versions = {name: version for name, version, _, _ in closure}
    confirmed = []
    for name, marker in BUNDLE_MARKERS.items():
        if name not in versions:
            die(
                f"bundle marker for {name!r} but the lockfile closure has no such package - "
                "a bundled dependency is missing from frontend/package-lock.json"
            )
        wanted = marker.replace("{version}", versions[name])
        if wanted not in text:
            die(
                f"{name} {versions[name]}: {wanted!r} is not in {BUNDLE_DIR} - the committed "
                "bundle was not built from frontend/package-lock.json; run `cd frontend && npm ci "
                "&& npm run build`"
            )
        confirmed.append(name)
    return confirmed


def render(closure: list[tuple[str, str, str, dict]], confirmed: list[str]) -> str:
    markers = textwrap.fill(
        ", ".join(sorted(confirmed)) or "none",
        width=78,
        initial_indent="    ",
        subsequent_indent="    ",
    )
    header = (
        HEADER.replace("@@PRESERVED@@", PRESERVED_SECTIONS)
        .replace("@@TOTAL@@", str(len(closure)))
        .replace("@@CHECKED@@", str(len(confirmed)))
        .replace("@@MARKERS@@", markers)
    )
    entries = "\n".join(
        render_entry(name, version, directory)
        for name, version, directory, _ in closure
    )
    return f"{header}\n\n{entries}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed notices are stale instead of writing them",
    )
    arguments = parser.parse_args()

    if not NODE_MODULES.is_dir():
        die(f"{NODE_MODULES} is missing; run `cd frontend && npm ci` first")

    closure = load_closure()
    document = render(closure, verify_bundle(closure, bundle_text()))

    stale = []
    for output in OUTPUTS:
        current = output.read_text(encoding="utf8") if output.is_file() else None
        if current == document:
            continue
        stale.append(output)
        if not arguments.check:
            output.write_text(document, encoding="utf8")

    if arguments.check:
        if stale:
            for output in stale:
                print(f"stale: {output}", file=sys.stderr)
            print("run `make licenses` and commit the result", file=sys.stderr)
            return 1
        print(f"{len(closure)} packages; notices up to date")
        return 0

    for output in OUTPUTS:
        state = "updated" if output in stale else "unchanged"
        print(f"{state}: {output.relative_to(REPO_ROOT)}")
    print(f"{len(closure)} packages, {len(document)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
