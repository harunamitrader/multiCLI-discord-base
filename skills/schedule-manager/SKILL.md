---
name: schedule-manager
description: Manage CoDiCoDi cron jobs stored as JSON files in data/schedules. Use this skill when the user wants to create, edit, pause, resume, list, or delete scheduled prompts, or when they mention cron, periodic execution, schedules, or automation for CoDiCoDi sessions.
---

# Schedule Manager

Use this skill only for CoDiCoDi schedule files in `data/schedules/`.

## What To Manage

Each job is one JSON file:

```json
{
  "cron": "0 9 * * *",
  "prompt": "今日のタスクを整理して",
  "session": "morning-work",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

- File name without `.json` is the job name.
- Required fields: `cron`, `prompt`
- Optional fields: `session`, `timezone`, `active`
- Cron must use 5 fields.
- If `session` is omitted, CoDiCoDi uses the active session fallback.
- Default timezone is `Asia/Tokyo`.
- `active: false` means paused.

## Workflow

1. Read the current files in `data/schedules/` before editing.
2. If the user wants to add a job, create one JSON file only.
3. If the user wants to edit, update only the matching JSON file.
4. If the user wants to pause or resume, change only `active`.
5. If the user wants to delete, remove only the matching JSON file.
6. Keep JSON clean and valid with two-space indentation and a trailing newline.

## Allowed Operations

- Add: create `data/schedules/<job-name>.json`
- Edit: update an existing job file
- Pause: set `active` to `false`
- Resume: set `active` to `true`
- List: read all `data/schedules/*.json`
- Delete: remove a specific `data/schedules/<job-name>.json`

## Guardrails

- Do not modify files outside `data/schedules/`.
- Do not create non-JSON companion files.
- Do not rename a job unless the user explicitly asks for a new file name.
- Do not invent a session when the user did not specify one; omit the field instead.
- If a requested cron expression is invalid, stop and tell the user.
