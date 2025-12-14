#!/bin/bash
# Claude Orchestrator - Cleanup Hook
#
# This script is called when a Claude Code session ends.
# It stops the heartbeat process and notifies the orchestrator that the session is complete.
#
# IMPORTANT: This script MUST always exit 0 to avoid blocking Claude Code.
# All errors are handled gracefully and logged.
#
# Environment Variables (set by Claude Code):
#   CLAUDE_SESSION_ID - The Claude Code session identifier
#
# Environment Variables (configuration):
#   CLAUDE_ORCHESTRATOR_API  - API endpoint (default: http://localhost:3001)
#   CLAUDE_HOOK_SECRET       - Optional shared secret for hook authentication
#   ORCHESTRATOR_API_KEY     - Optional API key for session endpoint authentication
#   ORCHESTRATOR_SESSION_ID  - UUID of the orchestrator session

# Disable strict error mode - we handle errors gracefully to never block Claude Code
set +e

# Configuration with defaults
API_URL="${CLAUDE_ORCHESTRATOR_API:-http://localhost:3001}"
HOOK_SECRET="${CLAUDE_HOOK_SECRET:-}"
API_KEY="${ORCHESTRATOR_API_KEY:-}"
ORCHESTRATOR_SESSION_ID="${ORCHESTRATOR_SESSION_ID:-}"

# Stop the heartbeat background process
stop_heartbeat() {
    local session_id="$1"

    if [ -z "$session_id" ]; then
        return 0
    fi

    local pid_file="/tmp/claude-heartbeat-${session_id}.pid"

    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file" 2>/dev/null)
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "$pid_file" 2>/dev/null
    fi

    return 0
}

# Notify the orchestrator that the session is complete
notify_completion() {
    local session_id="$1"
    local status="${2:-completed}"

    if [ -z "$session_id" ]; then
        return 0
    fi

    local curl_args=(-sS -X PATCH)
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(--connect-timeout 5)
    curl_args+=(--max-time 10)

    if [ -n "$HOOK_SECRET" ]; then
        curl_args+=(-H "x-hook-secret: $HOOK_SECRET")
    fi

    if [ -n "$API_KEY" ]; then
        curl_args+=(-H "x-api-key: $API_KEY")
    fi

    curl_args+=(-d "{\"status\":\"$status\"}")
    curl_args+=("$API_URL/api/sessions/$session_id")

    curl "${curl_args[@]}" >/dev/null 2>&1 &

    return 0
}

# Main execution
main() {
    # Stop heartbeat if running
    if [ -n "$ORCHESTRATOR_SESSION_ID" ]; then
        stop_heartbeat "$ORCHESTRATOR_SESSION_ID"

        # Notify orchestrator of completion
        notify_completion "$ORCHESTRATOR_SESSION_ID" "completed"
    fi

    # Always exit 0 to not block Claude Code
    exit 0
}

# Run main function
main "$@"
