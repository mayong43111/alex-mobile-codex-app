---
name: narration-editing
description: 'Use when planning presenter narration, talking-head videos, digital presenters, storyboards, tail-frame continuation, shot changes, or a complete narrated presentation.'
---

# Narration Editing

## Purpose

Plan an edited presentation instead of treating a generated presenter as a real,
continuously filmed person. These are creative defaults and guidance, not API
validation, a quota, or a reason to reject a user's explicit creative choice.
Apply them to narration and storyboard tasks, not unrelated image requests.

## Procedure

1. Preserve the approved spoken text, order, voice, and necessary disclaimers.
   Break at complete thoughts and natural pauses, not an arbitrary duration.
2. Normally keep a presenter shot to at most two consecutive generated clips.
   After that, recommend a meaningful shot change rather than extending the
   tail-frame chain indefinitely. This is a preference, not a hard limit:
   an explicitly requested long take may continue for more clips.
3. Choose changes that support the content: a medium shot to a closer framing,
   a relevant document detail, an illustrative insert, or a concise key-point
   visual. For legal education, contract clauses or a checklist can illustrate
   the narration without inventing case facts, legal authority, or quotations.
4. Cut at a sentence boundary or topic change. Prefer clean cuts. Maintain the
   same voice and coherent audio level across visual changes; avoid unnecessary
   fades, animated transitions, rapid jump cuts, or continuous artificial zooms.
   Do not pad the requested duration with repeated clips or truncate speech.
5. Use the previous actual last frame for short same-shot continuations.
   At a genuine new shot, start from its deliberately prepared source rather
   than carrying facial distortions through a long sequence. Keep character,
   clothing, light, background, and eye line consistent unless a change is wanted.
6. Describe the proposed shot groups and required assets in the conversation.
   For six segments, a possible plan is 1-2 medium presenter, 3-4 document/detail
   insert or close framing, and 5-6 presenter conclusion. Adjust this example to
   the script and available material; do not impose it mechanically.

## Execution Boundaries

- Reuse the installed OpenMontage tools and the application's existing image
  preparation tools. Do not invent another generation or editing engine.
- The current avatar plan has one source image. `continueFromPrevious=true`
  uses the preceding tail frame; `false` reuses that same original source.
  Resetting to the same source is NOT a new camera angle, insert, or framing.
- Do not encode unsupported shot changes as if they were executable. When new
  framing or inserts are needed, explain the proposed preparation/assembly steps
  and available capabilities first. Ask before additional paid generation, and
  do not silently crop images, change providers, or promise automatic B-roll.
- Script discussion and this advice alone do not authorize media generation.
  Only execute the current user's explicit request. Keep the workflow in chat.
- Distinguish a storyboard proposal from executed edits. Never call a single-shot
  output a multi-shot edit. Tail conditioning does not guarantee seamless faces,
  pose, or lip sync; recommend reviewing the rendered boundaries and audio.