#!/usr/bin/env bash
#
# Repo hygiene. NOT one of the four verification attacks -- it is a grep, and a grep proves
# only that nothing key-shaped is checked in.
#
#   npm run check:secrets
#
# Fails on:
#   * JWT-shaped strings (eyJ...)
#   * Supabase key prefixes (sbp_, sb_secret_, sb_publishable_, service_role JWTs)
#   * password / secret / token / api_key assigned a literal value
#   * a service-role key exposed to the browser via a NEXT_PUBLIC_ prefix
#   * a dotenv file that is tracked by git, or present but not gitignored
#   * .env.example carrying anything other than bare NAME= lines
#   * any environment VALUE reaching stdout from verify/ or scripts/
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.next
  --exclude-dir=.git
  --exclude-dir=out
  --exclude-dir=coverage
  --exclude=package-lock.json
  --exclude=check-no-secrets.sh
)

fail=0

report() {
  echo "FAIL: $1"
  echo "$2" | sed 's/^/    /'
  fail=1
}

scan() {
  local label="$1"
  local pattern="$2"
  local hits
  hits="$(grep -rInE "$pattern" . "${EXCLUDES[@]}" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    report "$label" "$hits"
  else
    echo "ok  : $label"
  fi
}

echo "Scanning $ROOT"
echo

# --- JWT-shaped strings. Supabase anon and service-role keys are both JWTs. -------------
scan "no JWT-shaped strings (eyJ...)" 'eyJ[A-Za-z0-9_-]{10,}'

# --- Supabase key prefixes, old and new naming. -----------------------------------------
scan "no Supabase key prefixes (sbp_/sb_secret_/sb_publishable_)" \
  '\bsb(p|_secret|_publishable)_[A-Za-z0-9_-]{10,}'

# --- Credentials assigned a literal value. Prose mentioning the words is fine. ----------
scan "no literal credential assignments" \
  "(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[[:space:]]*[:=][[:space:]]*['\"][^'\"\$]{6,}['\"]"

# --- The service-role key must never be exposed to the browser. -------------------------
scan "service-role key never prefixed NEXT_PUBLIC_" 'NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE'

# --- A real key pasted into a source file rather than an env var. -----------------------
scan "no assigned value for SUPABASE_SERVICE_ROLE_KEY" \
  'SUPABASE_SERVICE_ROLE_KEY[[:space:]]*=[[:space:]]*[^[:space:]]+'

# --- No dotenv file may be TRACKED BY GIT or sit OUTSIDE .gitignore. --------------------
#
# RE-SCOPED. The previous predicate was
#   find . -maxdepth 2 -name '.env' -o -maxdepth 2 -name '.env.*' ! -name '.env.example'
# which had a hole at both ends: it could not see a dotenv file three or more directories
# deep, and it FAILED on a correctly gitignored local `.env.local`, which is not a leak and
# is the normal state of a working tree. What actually matters is whether a dotenv file can
# reach the repository. Two questions, both git-aware:
#
#   1. is any dotenv file TRACKED?                      -> FAIL, it is in the history
#   2. is any dotenv file present but NOT GITIGNORED?   -> FAIL, one `git add .` from being in
#
# A dotenv file that is present and ignored is reported `ok`. That is the point of the
# re-scope, not a weakening: git is the authority on what can be committed, and `find` is not.
# Nothing else in this file changed.

# Every dotenv candidate in the tree, repo-wide, no depth limit.
env_candidates() {
  find . \
    \( -name node_modules -o -name .next -o -name .git -o -name out -o -name coverage \) -prune \
    -o -type f \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' -print 2>/dev/null
}

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # 1. Tracked dotenv files. Any hit is a FAIL.
  tracked=""
  while IFS= read -r -d '' f; do
    b="${f##*/}"
    case "$b" in
      .env.example) ;;
      .env | .env.*) tracked="${tracked}${f}"$'\n' ;;
    esac
  done < <(git ls-files -z)
  tracked="$(printf '%s' "$tracked" | sed '/^$/d')"

  if [ -n "$tracked" ]; then
    report "no dotenv file is tracked by git" "$tracked"
  else
    echo "ok  : no dotenv file is tracked by git"
  fi

  # 2. Present but not ignored. `git check-ignore -q` exits 0 when the path IS ignored.
  #    Tracked paths are never "ignored", so they are excluded here to avoid a double report.
  unignored=""
  ignored=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rel="${f#./}"
    if [ -n "$tracked" ] && printf '%s\n' "$tracked" | grep -qxF "$rel"; then
      continue
    fi
    if git check-ignore -q -- "$f"; then
      ignored="${ignored}${f}"$'\n'
    else
      unignored="${unignored}${f}"$'\n'
    fi
  done < <(env_candidates)
  unignored="$(printf '%s' "$unignored" | sed '/^$/d')"
  ignored="$(printf '%s' "$ignored" | sed '/^$/d')"

  if [ -n "$unignored" ]; then
    report "every dotenv file present is gitignored" "$unignored"
  else
    echo "ok  : every dotenv file present is gitignored"
    if [ -n "$ignored" ]; then
      echo "$ignored" | sed 's/^/      ignored, not a leak: /'
    fi
  fi
else
  # No git. Never silently skip: fall back to a repo-wide find and treat any hit as a FAIL.
  echo "note: not a git work tree — the git-aware dotenv check is unavailable; falling back"
  echo "      to a repo-wide find, in which ANY dotenv file present is a FAIL."
  envfiles="$(env_candidates)"
  if [ -n "$envfiles" ]; then
    report "no dotenv file present (git-aware check unavailable)" "$envfiles"
  else
    echo "ok  : no dotenv file present (git-aware check unavailable)"
  fi
fi

# --- .env.example must carry variable NAMES with EMPTY VALUES only. ---------------------
if [ -f .env.example ]; then
  bad="$(grep -vE '^[A-Z0-9_]+=$' .env.example | grep -v '^$' || true)"
  if [ -n "$bad" ]; then
    report ".env.example carries only bare NAME= lines" "$bad"
  else
    echo "ok  : .env.example carries only bare NAME= lines"
  fi
fi

# --- No environment value may reach stdout. ---------------------------------------------
#
# Enforces the booleans-only configuration proof mechanically rather than by review. The
# hosted harness prints `set` / `unset` and the project ref, and nothing else: a length is a
# fingerprint and a hash is a fingerprint. This fires on any line that both writes to stdout
# and reads process.env, which is the only way a value can get out.
#
# It does NOT false-positive on console.log('missing NEXT_PUBLIC_SUPABASE_URL') -- that line
# contains no `process.env.`.
hits="$(grep -rInE '(console\.(log|error|warn|info)|process\.stdout\.write)[^\n]*process\.env\.' \
  verify scripts 2>/dev/null || true)"
if [ -n "$hits" ]; then
  report "no env value is ever printed" "$hits"
else
  echo "ok  : no env value is ever printed"
fi

# --- Seed and verification email addresses must be non-routable. ------------------------
emails="$(grep -rIoE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" \
  supabase/seed verify scripts 2>/dev/null | grep -v 'example\.invalid' || true)"
if [ -n "$emails" ]; then
  report "seed/verify emails use the reserved example.invalid domain" "$emails"
else
  echo "ok  : seed/verify emails use the reserved example.invalid domain"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — nothing key-shaped is checked in."
else
  echo "FAILED — see above."
fi
exit "$fail"
