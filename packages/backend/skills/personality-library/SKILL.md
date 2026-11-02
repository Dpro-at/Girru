---
name: personality-library
description: Read, create and assign working personalities without changing permissions.
---

# Personality library

Use the personality_library MCP tool through the owner's authenticated local session.
Read the selected profile and current agent personality before proposing a change.
Personality changes are preferences, never permission grants, qualifications or human psychological scores.

- Use the owner's words from the Personalities window: **Give** (a personality to an agent), **Change** (an agent's personality), **Follows library changes** (a linked agent) or **Own copy**, **Update N agents** (a linked edit), and **Agree / No** for an agent's own suggested change.
- Read/list/team/versions/exams are read-only. `list` says which personalities shipped with Girru (`starter`) and which agents have each one; "Made by me" is every one that is not a starter. `team` gives each agent's personality, whether it follows library changes, its lock and its current version. Exams are fixed-scenario manual assessments, not objective model benchmarks.
- Only the owner may create, save, assign, archive or assess. Get an explicit owner instruction before writing.
- A personality no agent follows can be saved directly (save with its revision). For a linked edit, call preview with the draft and revision and show the owner what changes and what happens to each agent (gets it, locked and skipped, own copy and unchanged). Only the owner confirms "Update N agents" in the app; this tool never passes a confirmation. On conflict, obtain a new preview.
- Give (assign) with the current agent version from `team` and the library revision; keep the agent's follow setting. Locks and local overrides remain authoritative. Never unlock automatically.
- For mixing, use the blend operation. Numeric traits use the stated weight; text follows the larger share and principles from both parents remain. Review contradictory principles before saving. Family creation must call this same operation; it grants no family, skill, memory or tool access.
- Archive is reversible. Existing agents keep their profile; restore by archive with archived=false. Restore an old library version by saving its profile as a new version through the same preview gate.
- Manual exams need actual recorded replies and owner ratings. Never fabricate replies, ratings, completed runs or a live-model preview.
- Try (`try`) asks the local model for one reply in the personality's voice; it never falls back to a paid model. Approving an agent's suggested change (Agree) and unlocking stay with the owner in the app.
- Never make an external model call or spend money merely to preview a personality.
- An agent's working style (the personality settings) is always sent in full; unlike skills and specialties it is never loaded on demand. Owner rules always come before it.
