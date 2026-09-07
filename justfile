set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# confirms local tooling is on PATH
doctor:
    @command -v bun >/dev/null || (echo "missing: bun" && exit 1)
    @command -v lefthook >/dev/null || (echo "missing: lefthook" && exit 1)
    @command -v gitleaks >/dev/null || (echo "missing: gitleaks" && exit 1)
    @echo "bun:      $(bun --version)"
    @echo "lefthook: $(lefthook version)"
    @echo "gitleaks: $(gitleaks version)"

lint:
    bun run lint
    gitleaks detect --no-banner --redact

test:
    bun test

check: lint test

# hits real third-party APIs; skips sources with no credentials set
smoke-live:
    bun run smoke-live
