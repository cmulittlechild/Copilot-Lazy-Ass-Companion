#!/usr/bin/env python3
"""Convert VS Code Copilot Chat transcripts to OpenCode export JSON format."""

import json
import os
import glob
import uuid
import re
from datetime import datetime

# Workspace storage directories that map to /Users/xin/Desktop/sidecar_remote
WORKSPACE_DIRS = [
    "6ea7fd91d95d0ee7b8771238283ff09b",  # sidecar_remote
    "a820257afc3e6ec8435c4cfef52457f6",  # sidecar_remote/companion-open
]

PROJECT_DIR = "/Users/xin/Desktop/sidecar_remote"
OUTPUT_DIR = "/tmp/copilot_sessions"

OPENCODE_VERSION = "1.18.15"


def iso_to_ms(iso_str):
    """Convert ISO 8601 string to milliseconds since epoch."""
    if not iso_str:
        return 0
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def extract_text(content):
    """Extract text from content which can be a string or an array of segments."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content) if content else ""


def make_id(prefix):
    """Generate an OpenCode-style ID."""
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def parse_transcript(filepath):
    """Parse a single Copilot transcript JSONL file and return OpenCode export dict."""
    events = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not events:
        return None

    # Find session.start
    session_start = None
    for evt in events:
        if evt["type"] == "session.start":
            session_start = evt
            break

    if not session_start:
        return None

    session_data = session_start.get("data", {})
    session_id = session_data.get("sessionId", os.path.basename(filepath).replace(".jsonl", ""))
    start_time_ms = iso_to_ms(session_data.get("startTime"))

    # Collect all user.message events
    user_messages = [evt for evt in events if evt["type"] == "user.message"]
    if not user_messages:
        return None  # Skip empty sessions with no user messages

    # Build tool execution lookup: toolCallId -> (execution_start, execution_complete)
    tool_exec_start = {}
    tool_exec_complete = {}
    for evt in events:
        if evt["type"] == "tool.execution_start":
            tcid = evt["data"]["toolCallId"]
            tool_exec_start[tcid] = evt
        elif evt["type"] == "tool.execution_complete":
            tcid = evt["data"]["toolCallId"]
            tool_exec_complete[tcid] = evt

    # Build a flat ordered list of message events (user.message and assistant.message)
    # We need to preserve order and group them into turns
    message_events = [evt for evt in events if evt["type"] in ("user.message", "assistant.message")]

    if not message_events:
        return None

    # Title: first user message first line
    first_user_text = extract_text(user_messages[0].get("data", {}).get("content", ""))
    title_line = first_user_text.strip().split("\n")[0][:80] if first_user_text.strip() else "Untitled"
    title = f"[Copilot] {title_line}"

    # Build OpenCode messages
    opencode_messages = []
    prev_msg_id = None
    session_id_oc = f"ses_{uuid.uuid4().hex[:24]}"

    for evt in message_events:
        evt_type = evt["type"]
        evt_data = evt.get("data", {})
        evt_time_ms = iso_to_ms(evt.get("timestamp"))
        evt_id = evt.get("id", make_id("evt"))

        if evt_type == "user.message":
            msg_id = make_id("msg")
            text = extract_text(evt_data.get("content", ""))
            if not text.strip():
                continue

            part_id = make_id("prt")
            msg = {
                "info": {
                    "role": "user",
                    "time": {"created": evt_time_ms},
                    "agent": "build",
                    "model": {"providerID": "copilot", "modelID": "copilot-agent"},
                    "id": msg_id,
                    "sessionID": session_id_oc,
                },
                "parts": [
                    {
                        "type": "text",
                        "text": text,
                        "id": part_id,
                        "sessionID": session_id_oc,
                        "messageID": msg_id,
                    }
                ],
            }
            opencode_messages.append(msg)
            prev_msg_id = msg_id

        elif evt_type == "assistant.message":
            msg_id = make_id("msg")
            content = extract_text(evt_data.get("content", ""))
            tool_requests = evt_data.get("toolRequests", [])
            reasoning_text = evt_data.get("reasoningText", "")

            parts = []

            # Add reasoning if present
            if reasoning_text:
                prt_id = make_id("prt")
                parts.append({
                    "type": "reasoning",
                    "text": reasoning_text,
                    "time": {"start": evt_time_ms, "end": evt_time_ms},
                    "id": prt_id,
                    "sessionID": session_id_oc,
                    "messageID": msg_id,
                })

            # Add text part if non-empty
            if content.strip():
                prt_id = make_id("prt")
                parts.append({
                    "type": "text",
                    "text": content,
                    "time": {"start": evt_time_ms, "end": evt_time_ms},
                    "id": prt_id,
                    "sessionID": session_id_oc,
                    "messageID": msg_id,
                })

            # Add tool parts
            for tr in tool_requests:
                tcid = tr.get("toolCallId", "")
                tool_name = tr.get("name", "unknown")

                # Parse arguments
                args_raw = tr.get("arguments", "{}")
                if isinstance(args_raw, str):
                    try:
                        args = json.loads(args_raw)
                    except json.JSONDecodeError:
                        args = {"raw": args_raw}
                else:
                    args = args_raw

                # Get execution info
                exec_start = tool_exec_start.get(tcid)
                exec_complete = tool_exec_complete.get(tcid)

                state = {
                    "status": "completed" if exec_complete else "running",
                    "input": args,
                    "output": "",
                    "title": tool_name,
                    "metadata": {},
                }

                if exec_complete:
                    success = exec_complete["data"].get("success", True)
                    if success:
                        state["status"] = "completed"
                    else:
                        state["status"] = "error"
                        state["error"] = "Tool execution failed"

                if exec_start:
                    start_ms = iso_to_ms(exec_start.get("timestamp"))
                    end_ms = iso_to_ms(exec_complete.get("timestamp")) if exec_complete else start_ms
                    state["time"] = {"start": start_ms, "end": end_ms}
                else:
                    state["time"] = {"start": evt_time_ms, "end": evt_time_ms}

                prt_id = make_id("prt")
                parts.append({
                    "type": "tool",
                    "tool": tool_name,
                    "callID": tcid,
                    "state": state,
                    "id": prt_id,
                    "sessionID": session_id_oc,
                    "messageID": msg_id,
                })

            if not parts:
                # Skip assistant messages with no content and no tool requests
                continue

            info = {
                "role": "assistant",
                "time": {"created": evt_time_ms, "completed": evt_time_ms},
                "agent": "build",
                "mode": "build",
                "modelID": "copilot-agent",
                "providerID": "copilot",
                "id": msg_id,
                "sessionID": session_id_oc,
                "parentID": prev_msg_id or f"msg_{uuid.uuid4().hex[:22]}",
                "cost": 0,
                "tokens": {"total": 0, "input": 0, "output": 0, "reasoning": 0, "cache": {"write": 0, "read": 0}},
                "path": {"cwd": PROJECT_DIR, "root": "/"},
            }
            msg = {
                "info": info,
                "parts": parts,
            }
            opencode_messages.append(msg)
            prev_msg_id = msg_id

    if not opencode_messages:
        return None

    # Calculate last updated time
    last_time = max(
        (msg["info"]["time"]["created"] for msg in opencode_messages if msg["info"]["time"].get("created")),
        default=start_time_ms,
    )

    slug = title.replace(" ", "-").lower()[:30]
    slug = re.sub(r"[^a-z0-9-]", "", slug)

    export = {
        "info": {
            "id": session_id_oc,
            "slug": slug,
            "projectID": "global",
            "directory": PROJECT_DIR,
            "path": PROJECT_DIR.replace("/Users/", ""),
            "title": title,
            "agent": "build",
            "model": {"id": "copilot-agent", "providerID": "copilot"},
            "version": OPENCODE_VERSION,
            "summary": {"additions": 0, "deletions": 0, "files": 0},
            "cost": 0,
            "time": {
                "created": start_time_ms if start_time_ms else opencode_messages[0]["info"]["time"]["created"],
                "updated": last_time,
            },
            "tokens": {
                "input": 0,
                "output": 0,
                "reasoning": 0,
                "cache": {"read": 0, "write": 0},
            },
        },
        "messages": opencode_messages,
    }

    return export


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    base = os.path.expanduser("~/Library/Application Support/Code/User/workspaceStorage")
    all_transcripts = []

    for ws_hash in WORKSPACE_DIRS:
        tdir = os.path.join(base, ws_hash, "GitHub.copilot-chat", "transcripts")
        if os.path.isdir(tdir):
            all_transcripts.extend(sorted(glob.glob(os.path.join(tdir, "*.jsonl"))))

    print(f"Found {len(all_transcripts)} transcript files")

    converted = 0
    skipped = 0

    for tf in all_transcripts:
        fname = os.path.basename(tf)
        print(f"  Processing: {fname}...", end=" ")

        result = parse_transcript(tf)
        if result is None:
            print("SKIP (empty/no user messages)")
            skipped += 1
            continue

        out_file = os.path.join(OUTPUT_DIR, fname.replace(".jsonl", ".json"))
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        msg_count = len(result["messages"])
        print(f"OK ({msg_count} messages) -> {out_file}")
        converted += 1

    print(f"\nDone: {converted} converted, {skipped} skipped")
    print(f"Output: {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
