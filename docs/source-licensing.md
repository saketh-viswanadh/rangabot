# Starter source licensing audit

Verified 2026-07-28.

Rangabot does not redistribute the official documentation or Project Gutenberg
books listed in `data/knowledge/SOURCE_MANIFEST.json`. Users download source
material into the Git-ignored private inbox, and the generated index remains
local. The public repository contains metadata, links, short original subject
briefs and the synthetic Apache-2.0 example only.

| Collection | Upstream terms | Repository treatment |
| --- | --- | --- |
| Python documentation | PSF License Version 2; documentation code examples may also use 0BSD | Metadata only; local download |
| Apache Spark documentation | Apache-2.0 | Metadata only; local download |
| NumPy documentation | BSD-3-Clause | Metadata only; local download |
| pandas documentation | BSD-3-Clause | Metadata only; local download |
| scikit-learn documentation | BSD-3-Clause | Metadata only; local download |
| DuckDB documentation | MIT | Metadata only; local download |
| Gutenberg mythology texts | Public domain determination is US-based; Gutenberg terms and local jurisdiction apply | Metadata only; local download; no bundled text |
| Rangabot example lesson | Apache-2.0, original project text | Redistributed in `data/knowledge/examples` |

Every manifest record includes its direct license URL and distribution policy.
Maintainers must not change a source to “redistributed” without preserving all
required notices and reviewing the exact version and jurisdiction. User-provided
books are private inputs, not project contributions, unless deliberately
submitted under a compatible license.
