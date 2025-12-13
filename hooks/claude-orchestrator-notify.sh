#!/bin/bash
# Claude Orchestrator - Notification Hook
#
# This script is called by Claude Code for status notifications.
# It implements reliable event delivery with local logging and retry support.
#
# IMPORTANT: This script MUST always exit 0 to avoid blocking Claude Code.
# All errors are handled gracefully and logged for later retry.
#
# Environment Variables (set by Claude Code):
#   CLAUDE_SESSION_ID - The Claude Code session identifier
#   MESSAGE           - The notification message
#
# Environment Variables (configuration):
#   CLAUDE_ORCHESTRATOR_API  - API endpoint (default: http://localhost:3001)
#   CLAUDE_ORCHESTRATOR_LOGS - Log directory (default: /var/log/claude-orchestrator/events)
#   CLAUDE_HOOK_SECRET       - Optional shared secret for authentication
#   HOOK_TIMEOUT             - HTTP timeout in seconds (default: 5)

# Disable strict error mode - we handle errors gracefully to never block Claude Code
set +e

# Configuration with defaults
API_URL="${CLAUDE_ORCHESTRATOR_API:-http://localhost:3001}"
LOG_DIR="${CLAUDE_ORCHESTRATOR_LOGS:-/var/log/claude-orchestrator/events}"
HOOK_SECRET="${CLAUDE_HOOK_SECRET:-}"
TIMEOUT="${HOOK_TIMEOUT:-5}"
MAX_MESSAGE_SIZE=10000

# Generate unique event ID using uuidgen or fallback
generate_uuid() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    elif [ -f /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
    else
        # Fallback: generate pseudo-UUID from timestamp and random
        printf '%08x-%04x-%04x-%04x-%012x\n' \
            "$(date +%s)" \
            "$((RANDOM % 65536))" \
            "$((RANDOM % 65536))" \
            "$((RANDOM % 65536))" \
            "$(od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d ' ' | head -c12 || echo $RANDOM$RANDOM)"
    fi
}

# Ensure log directory exists
ensure_log_dir() {
    if [ ! -d "$LOG_DIR" ]; then
        mkdir -p "$LOG_DIR" 2>/dev/null || true
    fi
}

# Write event to local log file
write_event_log() {
    local event_json="$1"
    local log_file="$LOG_DIR/events.log"

    echo "$event_json" >> "$log_file" 2>/dev/null || true
}

# Write failed event for retry
write_failed_event() {
    local event_json="$1"
    local error_msg="$2"
    local failed_file="$LOG_DIR/failed-events.ndjson"

    local failed_entry
    failed_entry=$(jq -c --arg error "$error_msg" --arg attempt "$(date -Iseconds)" \
        '{event: ., error: $error, lastAttempt: $attempt, attempts: 1}' <<< "$event_json" 2>/dev/null)

    if [ -n "$failed_entry" ]; then
        echo "$failed_entry" >> "$failed_file" 2>/dev/null || true
    fi
}

# Truncate message to prevent oversized payloads
truncate_message() {
    local message="$1"
    local max_size="$2"

    if [ ${#message} -gt "$max_size" ]; then
        echo "${message:0:$max_size}... [truncated]"
    else
        echo "$message"
    fi
}

# Main execution
main() {
    # Generate unique event ID
    local event_id
    event_id=$(generate_uuid)

    # Get current timestamp
    local timestamp
    timestamp=$(date -Iseconds)

    # Truncate large messages
    local truncated_message
    truncated_message=$(truncate_message "${MESSAGE:-}" "$MAX_MESSAGE_SIZE")

    # Build event JSON payload
    local event_json
    event_json=$(jq -n -c \
        --arg eventId "$event_id" \
        --arg session "${CLAUDE_SESSION_ID:-unknown}" \
        --arg message "$truncated_message" \
        --arg timestamp "$timestamp" \
        '{
            eventId: $eventId,
            eventType: "notification",
            session: $session,
            message: $message,
            timestamp: $timestamp
        }' 2>/dev/null)

    # Ensure we have valid JSON
    if [ -z "$event_json" ]; then
        # Fallback: minimal JSON without jq
        event_json="{\"eventId\":\"$event_id\",\"eventType\":\"notification\",\"session\":\"${CLAUDE_SESSION_ID:-unknown}\",\"timestamp\":\"$timestamp\"}"
    fi

    # Ensure log directory exists
    ensure_log_dir

    # Write to local event log first (before HTTP attempt)
    write_event_log "$event_json"

    # Build curl command with optional authentication
    local curl_args=(-sS -X POST)
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(--connect-timeout "$TIMEOUT")
    curl_args+=(--max-time "$((TIMEOUT * 2))")

    if [ -n "$HOOK_SECRET" ]; then
        curl_args+=(-H "x-hook-secret: $HOOK_SECRET")
    fi

    curl_args+=(-d "$event_json")
    curl_args+=("$API_URL/api/hooks/notification")

    # Attempt HTTP POST
    local http_code
    local curl_output
    curl_output=$(curl "${curl_args[@]}" -w "\n%{http_code}" 2>&1) || true

    # Extract HTTP status code (last line)
    http_code=$(echo "$curl_output" | tail -n1)

    # Check for success (2xx status)
    if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
        # Success - event delivered
        exit 0
    else
        # Failure - write to failed events queue for retry
        local error_msg="HTTP $http_code"
        if [ -z "$http_code" ] || [ "$http_code" = "000" ]; then
            error_msg="Connection failed"
        fi

        write_failed_event "$event_json" "$error_msg"
    fi

    # Always exit 0 to not block Claude Code
    exit 0
}

# Run main function
main "$@"
