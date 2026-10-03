#!/usr/bin/env sh
#
# Encoding hygiene for source files. Replaces the ../../tools/check-encoding.sh reference that
# only existed in the original monorepo, so `npm run check:all` works from a standalone clone.
#
#   sh scripts/check-encoding.sh app components lib scripts verify supabase
#   sh scripts/check-encoding.sh --self-test
#
# Fails on:
#   * a file that is not valid UTF-8
#   * a UTF-8 byte-order mark
#
set -u

check_file() {
  f="$1"
  if ! iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1; then
    echo "not valid UTF-8: $f"
    return 1
  fi
  if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    echo "UTF-8 byte-order mark: $f"
    return 1
  fi
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  printf 'ok\n' > "$tmp/good.ts"
  printf '\357\273\277bom\n' > "$tmp/bom.ts"
  printf '\377\376bad\n' > "$tmp/bad.ts"
  fail=0
  check_file "$tmp/good.ts" >/dev/null || { echo "self-test: clean file rejected"; fail=1; }
  check_file "$tmp/bom.ts" >/dev/null && { echo "self-test: BOM not detected"; fail=1; }
  check_file "$tmp/bad.ts" >/dev/null && { echo "self-test: invalid UTF-8 not detected"; fail=1; }
  rm -rf "$tmp"
  [ "$fail" -eq 0 ] && echo "check-encoding self-test passed"
  exit "$fail"
fi

status=0
for f in $(find "$@" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.js' \
  -o -name '*.cjs' -o -name '*.sql' -o -name '*.css' -o -name '*.json' -o -name '*.md' -o -name '*.sh' \) \
  -not -path '*/node_modules/*'); do
  check_file "$f" || status=1
done
[ "$status" -eq 0 ] && echo "check-encoding: all files clean"
exit "$status"
