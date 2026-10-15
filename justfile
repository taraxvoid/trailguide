set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# confirms local tooling is on PATH
doctor:
    @command -v bun >/dev/null || (echo "missing: bun" && exit 1)
    @command -v lefthook >/dev/null || (echo "missing: lefthook (run: mise install)" && exit 1)
    @command -v gitleaks >/dev/null || (echo "missing: gitleaks" && exit 1)
    @command -v typst >/dev/null || (echo "missing: typst (run: mise install)" && exit 1)
    @echo "bun:      $(bun --version)"
    @echo "lefthook: $(lefthook version)"
    @echo "gitleaks: $(gitleaks version)"
    @echo "typst:    $(typst --version)"

lint:
    bun run lint
    gitleaks detect --no-banner --redact

test:
    bun run test

typecheck:
    bun run typecheck

check:
    bun run check

# hits real third-party APIs; skips sources with no credentials set
smoke-live:
    bun run smoke-live
