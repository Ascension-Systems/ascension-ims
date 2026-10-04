#!/usr/bin/env bash
#
# Encoding hygiene for source files. Replaces the ../../tools/check-encoding.sh reference that
# only existed in the original monorepo, so `npm run check:all` works from a standalone clone.
#
#   bash scripts/check-encoding.sh app components lib scripts verify supabase
#   bash scripts/check-encoding.sh --self-test
#
# Fails on:
#   * a file that is not valid UTF-8
#   * a UTF-8 byte-order mark
#   * a requested root that does not exist, or a traversal error — an incomplete scan is a
#     failure, never "all files clean"
#
set -uo pipefail

check_file() {
  local f="$1"
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

scan() {
  local status=0 count=0 list root
  if [ "$#" -eq 0 ]; then
    echo "check-encoding: no roots given"
    return 1
  fi
  for root in "$@"; do
    if [ ! -e "$root" ]; then
      echo "check-encoding: root does not exist: $root"
      status=1
    fi
  done
  [ "$status" -eq 0 ] || return 1

  list="$(mktemp)"
  if ! find "$@" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.js' \
      -o -name '*.cjs' -o -name '*.sql' -o -name '*.css' -o -name '*.json' -o -name '*.md' \
      -o -name '*.sh' \) -not -path '*/node_modules/*' -print0 > "$list"; then
    echo "check-encoding: traversal failed; scan incomplete"
    rm -f "$list"
    return 1
  fi
  while IFS= read -r -d '' f; do
    count=$((count + 1))
    check_file "$f" || status=1
  done < "$list"
  rm -f "$list"

  if [ "$status" -eq 0 ]; then
    echo "check-encoding: $count files clean"
  fi
  return "$status"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/src dir"
  printf 'ok\n' > "$tmp/src dir/good file.ts"
  printf '\357\273\277bom\n' > "$tmp/bom.ts"
  printf '\377\376bad\n' > "$tmp/bad.ts"
  fail=0
  check_file "$tmp/src dir/good file.ts" >/dev/null || { echo "self-test: clean file rejected"; fail=1; }
  check_file "$tmp/bom.ts" >/dev/null && { echo "self-test: BOM not detected"; fail=1; }
  check_file "$tmp/bad.ts" >/dev/null && { echo "self-test: invalid UTF-8 not detected"; fail=1; }
  scan "$tmp/src dir" >/dev/null || { echo "self-test: path with spaces not scanned cleanly"; fail=1; }
  scan "$tmp" >/dev/null && { echo "self-test: bad files in a scanned root not reported"; fail=1; }
  scan "$tmp/does-not-exist" >/dev/null && { echo "self-test: missing root accepted"; fail=1; }
  rm -rf "$tmp"
  [ "$fail" -eq 0 ] && echo "check-encoding self-test passed"
  exit "$fail"
fi

scan "$@"
exit $?
