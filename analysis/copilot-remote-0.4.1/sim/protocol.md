# Copilot Remote protocol (reconstructed)

## Phone -> Server
- PHONE_CONNECT { fcmToken?: string }
- PHONE_MESSAGE { text: string, mode?: 'agent'|'ask'|'edit' }
- PHONE_CONFIRM { button: string }
- PHONE_PUSH_SUBSCRIBE { subscription: object }

## Server -> Phone
- SYSTEM_MESSAGE { text }
- USER_MESSAGE { text }
- AGENT_LIST { agents: string[], active: string }
- AGENT_STREAM_START { streamId, timestamp }
- AGENT_STREAM_SET { streamId, text, timestamp }
- AGENT_STREAM_CHUNK { streamId, text?, ... }
- AGENT_STREAM_END { streamId? }
- TOOL_CALL { text, toolId, isComplete, input, result }
- AGENT_CONFIRM { title, message, buttons }
- AGENT_CONFIRM_RESOLVED ?
- COPILOT_TYPING {}?
- COPILOT_DONE {}
- HISTORY_REPLAY { messages: any[] }
