#!/usr/bin/env bash
# Generates src/generated/openapi.ts from openapi.yaml and formats it as the commit hook
# does (biome with ai-review-ci's canonical config), so the committed file is what both the
# generator and the hook produce. `write` rewrites the file; `check` fails when it differs.
set -euo pipefail

target=src/generated/openapi.ts
configs="${AI_REVIEW_CI_CONFIGS:-$HOME/ai-review-ci/tool-configs}"
generated="$(openapi-typescript openapi.yaml |
	bun x --package @biomejs/biome biome check --write --unsafe \
		--config-path "$configs/biome.json" --stdin-file-path="$target")"

case "${1:-}" in
write)
	printf '%s\n' "$generated" >"$target"
	;;
check)
	if ! diff -u "$target" <(printf '%s\n' "$generated"); then
		echo "$target differs from the formatted generator output; run 'bun run openapi:generate'" >&2
		exit 1
	fi
	;;
*)
	echo "usage: $0 write|check" >&2
	exit 2
	;;
esac
