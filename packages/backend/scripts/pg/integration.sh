#!/usr/bin/env bash
# B2.2a: PostgreSQL integration run. Creates a throwaway database, applies
# migrations-pg with the PostgreSQL runner (twice: the second run must apply
# nothing), compares the schema with a fresh SQLite build, runs
# test/pg-identity.integration.test.mjs and (B2.2b)
# test/pg-auth-teams.integration.test.mjs and (B2.2b-2)
# test/pg-credentials.integration.test.mjs and (B2.2b-3)
# test/pg-agents-tasks.integration.test.mjs and (B2.2b-4)
# test/pg-memory.integration.test.mjs and (STORE-MAP-01 pilot) test/pg-store-pilot.integration.test.mjs and (P3) test/pg-store-p3.integration.test.mjs and (P7) test/pg-store-p7.integration.test.mjs and (B2.2c part 1)
# test/pg-platform.integration.test.mjs and (B2.2c part 2)
# test/pg-routes.integration.test.mjs and test/pg-boot.integration.test.mjs and (B2.2d)
# test/pg-storage, pg-evaluation, pg-workflows, pg-camera, pg-skills,
# pg-leftovers, pg-chat-sessions, pg-claude-import, pg-worlds, pg-marketplace,
# pg-calendar, pg-voice-messages, pg-orchestrator, pg-inbox, pg-update-tasks, pg-team-batch, pg-agent-permissions, pg-task-board and pg-boot-background (.integration.test.mjs)
# against it, then always drops it.
#
# Usage: scripts/pg/integration.sh [report-dir]
# Touches only the database named below on 127.0.0.1, as the current OS user.
set -euo pipefail

HOST=127.0.0.1
PORT=5432
DB=agent_player_rehearsal
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${1:-$(mktemp -d)}"
mkdir -p "$OUT_DIR"

pg_isready -h "$HOST" -p "$PORT"

exists() { psql -h "$HOST" -p "$PORT" -X -lqt | cut -d '|' -f 1 | tr -d ' ' | grep -qx "$DB"; }

if exists; then
  echo "database $DB already exists; refusing to touch it" >&2
  exit 2
fi

cleanup() {
  local rc=$?
  dropdb -h "$HOST" -p "$PORT" --if-exists "$DB" || true
  if exists; then echo "cleanup: $DB STILL EXISTS" >&2; else echo "cleanup: $DB dropped (not in psql -lqt)"; fi
  exit "$rc"
}

createdb -h "$HOST" -p "$PORT" "$DB"
trap cleanup EXIT
echo "created $DB"

URL="postgres://$HOST:$PORT/$DB"
cd "$BACKEND"
export PGOPTIONS="-c client_min_messages=warning"
AGENT_PLAYER_PG_URL="$URL" node --import tsx scripts/pg/migrate-pg.mjs | tail -n 1
AGENT_PLAYER_PG_URL="$URL" node --import tsx scripts/pg/migrate-pg.mjs | tail -n 1

node scripts/pg/compare-schema.mjs --host "$HOST" --db "$DB" --out "$OUT_DIR/compare-report.txt"

AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-identity.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-auth-teams.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-auth-teams-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-credentials.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-credentials-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-agents-tasks.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-agents-tasks-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-memory.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-memory-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-store-pilot.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-store-pilot-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-store-p3.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-store-p3-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" GIRRU_STORE_P6=1 node --import tsx --test --test-force-exit test/pg-store-p7.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-store-p7-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-platform.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-platform-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-routes.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-routes-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-boot.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-boot-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-storage.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-storage-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-evaluation.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-evaluation-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-workflows.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-workflows-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-camera.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-camera-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-skills.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-skills-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-leftovers.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-leftovers-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-chat-sessions.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-chat-sessions-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-claude-import.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-claude-import-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-worlds.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-worlds-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-marketplace.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-marketplace-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-calendar.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-calendar-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-voice-messages.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-voice-messages-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-orchestrator.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-orchestrator-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-inbox.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-inbox-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-update-tasks.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-update-tasks-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-team-batch.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-team-batch-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-agent-permissions.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-agent-permissions-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test test/pg-task-board.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-task-board-output.txt"
test "${PIPESTATUS[0]}" -eq 0
AGENT_PLAYER_PG_TEST_URL="$URL" node --import tsx --test --test-force-exit test/pg-boot-background.integration.test.mjs 2>&1 | tee "$OUT_DIR/integration-boot-background-output.txt"
test "${PIPESTATUS[0]}" -eq 0
echo "reports in $OUT_DIR"
