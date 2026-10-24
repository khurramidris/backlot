# The story engine

A customer types one line. The engine turns it into a developed story, a screenplay, a cast and set list, a
director's plan and, for every shot, a prompt the video model can render. This document explains how it does that,
why it is built the way it is, and how to tune and judge it.

The goal it is designed around: **the engine, not the model, carries the craft.** A frontier model should write
well here, and an ordinary one should still write something good, because every call it gets is small, concrete
and checked.

## The flow

```
idea ─▶ pitch ─▶ choose ─▶ bible ─▶ outline ─▶ scenes ─▶ critique ─▶ rewrites ─▶ breakdown ─▶ direction ─▶ shots ─▶ H3 prompts
        3 takes   rubric    story     scene     one per    located     only the     cast, sets   per        per      compiled
                  + notes   bible     cards     card       notes       flagged      props        episode    scene    in code
```

| Step | The model's one job | What code does around it |
|---|---|---|
| **pitch** (`writer.ts`) | Three genuinely different takes: protagonist, logline, engine, hook, turn, ending | Sparks, the customer's earlier stories, the format's register |
| **choose** | Score each take on a rubric (fidelity, hook, stakes, specificity, surprise, renderable) and write development notes | `pickConcept`: an unfaithful take can't win; best total wins; ties go to the model's own pick |
| **bible** | The story bible: characters (want, obstacle, secret, arc, voice with a verbal habit and sample lines, look), relationships, world, sets, setups and payoffs, each episode's opening and ending, the film's look | `cleanBible`: cue-safe ids, set names; `overusedNames` + a small **rename** call recasts "Maya" and friends everywhere |
| **outline** (per episode) | Scene cards: set, who, what each character wants and their tactic, what's underneath, the turn, the value change, key image, exit, setups and payoffs | Scene count range and a **timed beat grid** for the runtime (`sceneRange`, `rhythm`); `cleanOutline` maps sets and ids, scales seconds to the runtime; `plantNotes` |
| **scenes** (per episode, in parallel) | Write one scene from its card, as elements (action / line) | A **word budget** per scene (`budget`); two **worked examples** (`craft.ts`); `cleanScene` + `sceneProblem` (unknown speakers, wrong length → one retry); Fountain rendered by code (`sceneFountain`). Each episode's opening and ending are drafted twice and a **judge** keeps the better |
| **critique** | Score the screenplay and give located notes ("quote → fix") per scene, or keep it | `storyLint` runs first; its findings and the setup/payoff notes go in |
| **rewrites** (per episode) | Rewrite only the flagged scenes, from the notes | A rewrite is kept only if the checks don't get worse **and** a pairwise judge prefers it (order randomised per pair; a slight preference for the original yields to fewer issues) |
| **breakdown** | Casting, costume and production design | `repair` (every scene in one set, looks partition appearances) |
| **direction** | Visual approach and a plan per scene | Gets the writers' cards, the characters' wants and secrets, the world's sensory palette |
| **shots** (per scene, in parallel) | Beats with framing, lens, move, blocking, performance, light, verbatim dialogue | Gets the card (purpose, wants, subtext, turn) and a **code-made coverage** that is timing-safe; `repairShots` guarantees every line and action; `compileShot` builds the H3 prompt |

Every writing step is its own autopilot run with its state in `projects.autopilot.writing`, so a restart resumes and
no job runs long. The cards are saved in `story_bible.outline`; the quality report (lint, critic scores, what the
polish changed, the takes and their scores) in `story_bible.quality`.

## Why it's built this way

The previous engine asked one strong call to do a lot at once: invent three takes, pick one and write the whole
treatment; then write every episode's Fountain in one JSON string while holding ~40 rules; then critique and
rewrite the whole script. That works when the model plans silently in its own thinking. A weaker model, or the same
model at low effort, can't, and quality collapses in predictable ways. Each principle below answers one of them.

1. **One small, checkable job per call.** Long outputs that juggle many constraints are where models drop rules.
   A scene card or a single scene is short enough that even a small model keeps every instruction in view.
2. **Numbers are computed in code, never estimated by the model.** "Hit 75 seconds at 2.4 words a second" is
   arithmetic a model does badly while writing. Code turns the runtime into a scene count, seconds per scene, words
   of dialogue and action lines per scene, and a beat grid with the seconds filled in ("about 19s: FIRST TURN").
3. **Examples, not only rules.** Rules say what to avoid; a weak model learns far more from seeing a weak and a
   strong version of the same moment. `craft.ts` holds such pairs (subtext, distinct voices, filmable action,
   openings, cliffhangers, turns, exposition as ammunition, heightened confrontation, messages without readable
   text). They come from deliberately varied worlds and rotate per scene so none becomes a template.
4. **Choosing is easier than writing.** Models judge better than they generate, so the engine generates options
   where it matters most (three takes; two drafts of every opening and ending) and picks with a rubric or a pairwise
   judge. Pairwise beats absolute scores, and randomising the order cancels position bias.
5. **Critique is located and narrow; rewrites are local and must earn their place.** A holistic "make it better and
   return everything" pass lets a weaker model flatten a good draft. Here the editor names scenes and quotes, only
   those scenes are rewritten, and a rewrite that makes the checks worse or loses to the original is thrown away.
6. **Intent travels downstream.** The card says what a scene is for, what each character wants and what is going on
   underneath. The director and the shot planner get it, so performance notes play the subtext ("she smiles; her
   hands keep folding the same towel") instead of being re-guessed from the dialogue, and the camera changes where
   the scene turns.
7. **Code enforces what models forget.** Cue-safe ids, known sets and characters, overused names recast once at the
   point they are chosen, setups that pay off, dialogue verbatim, every action line covered, H3's limits, and a
   lint that catches the habits of weaker models: named feelings, exposition, filler openers, characters calling
   each other by name, "what do you mean?", unfilmable or camera-directing action, a slow opening, an ending that
   trails off on talk, and the customer's own names and places going missing. English-only checks run only on
   English dialogue.
8. **The format sets the register.** A microdrama is heightened and fast (open at boiling point, confrontations
   out loud, a flip every 20–30 seconds, a cliffhanger, the genre's tropes welcome when executed specifically); a
   short film is restrained (subtext, one turn, an ending that lands quietly). One set of rules for both made
   microdramas too polite and short films too loud. See `FORMAT_CRAFT` in `prompts.ts`.
9. **Nothing in a prompt is an accidental attractor.** Specific examples in instructions ("a pressure cooker
   whistle", "RIZVI MEDICAL STORE") leak into every story a weaker model writes. Concrete examples now live only in
   the rotating worked examples; the rules describe form, and the sound and texture of each film come from its own
   bible's sensory palette.
10. **Production documents, never reasoning fields.** Every answer is something the next step uses (a take, a card,
    a scene, an editor's note, a verdict). Thinking stays internal (see the invariants in `ARCHITECTURE.md`).

## Running it on a cheaper or different model

Every step can run on its own model, and the client copes with endpoints that lack Anthropic's newer features:

```bash
CLAUDE_MODEL=claude-opus-5-5                    # the default for every step
CLAUDE_MODELS=scene:claude-sonnet-5-5,judge:claude-sonnet-5-5,shots:claude-sonnet-5-5
```

Steps: `pitch`, `choose`, `bible`, `rename`, `outline`, `scene`, `critique`, `judge`, `breakdown`, `direct`, `shots`,
`retake`. A good split keeps the strongest model where the story is decided (pitch, choose, bible, outline,
critique) and puts the many small calls (scene, judge, shots) on a cheaper one: the cards, budgets and examples
carry most of the craft those calls need.

- `CLAUDE_STRUCTURED_OUTPUTS=0`: for a model or endpoint without structured outputs. The answer's shape is described
  in the prompt (a commented JSON outline made from the schema, `schemaHint`), replies are parsed leniently, and an
  answer that doesn't parse or fit gets one repair round showing the model what was wrong.
- `CLAUDE_THINKING=0`: no thinking or effort parameters are sent.
- Either feature also switches itself off, per model, when the endpoint answers 400 naming it.

## Tuning

- Prompts: `engine/src/pipeline/prompts.ts` (format registers in `FORMAT_CRAFT`, the bible as shared context in
  `bibleText`, card rendering in `cardLine` / `cardText`).
- Answer shapes and per-field instructions: `schemas.ts`. Enums and numbers aren't enforced by the API; code
  normalises them.
- Worked examples for writing: `craft.ts`. Add a pair with a weak version, a strong version, the principle, and tags.
  The unit tests hold every strong version to the same lint the writers face.
- Shot grammar examples: `exemplars.ts`.
- Numbers and checks: `story.ts` (`budget`, `sceneRange`, `rhythm`, `cleanOutline`, `sceneProblem`, `storyLint`).
- Knobs: `STORY_EFFORT`, `PLANNING_EFFORT`, `SCRIPT_DOCTOR` (the critique and rewrites), `KEY_SCENE_DRAFTS` (drafts of
  each opening and ending, 1 to 3), `PLAN_CONCURRENCY` (scenes written or planned at once).

## Judging a change

```bash
# Free: the whole flow on mock providers, plus every prompt exactly as a model would see it
DATABASE_URL=postgres://postgres@localhost:5432/<empty db> MOCK_PROVIDERS=1 PROMPT_LOG_DIR=data/prompts npm --prefix engine run eval:story
# Real (about $1 to $3 per idea at Opus prices): read the scripts, not just the numbers
DATABASE_URL=… ANTHROPIC_API_KEY=… EVAL_CONFIRM=1 npm --prefix engine run eval:story -- --only 3
```

Each idea gets a folder with the takes and their scores (`takes.md`), the bible, the scene cards (`outline.md`), the
script, the design, the director's plan and the compiled shot prompts. The report has open lint issues, the critic's
scores (the model grading its own room, so compare runs rather than trust one number), rewrites kept, shot variety
and cost. To see how far the engine carries a cheaper model, run the same ideas with `CLAUDE_MODEL` (or
`CLAUDE_MODELS`) changed and read the scripts side by side.

## Cost and time

A 75-second microdrama makes about 18 writing calls (3 takes and a verdict, the bible, one board, 5 to 7 scenes plus
2 extra drafts and a verdict, the notes, 2 or 3 rewrites and a verdict), then the breakdown, the director's pass and
one shot call per scene. Most of them are short, and the system prompt and the bible are cached across a project's
calls. On one model this costs somewhat more than the previous three big calls and takes a few more minutes before
the checkpoint; putting the scene, judge and shot steps on a cheaper model (`CLAUDE_MODELS`) brings it below the
previous cost. `SCRIPT_DOCTOR=0` and `KEY_SCENE_DRAFTS=1` are the fastest settings. Check real numbers on the Admin
page ("our cost" per film) and against `SETUP_FEE_USD`.

## Next

- Run the real eval on Opus and on a cheaper model, read the scripts, and tune `FORMAT_CRAFT` and the worked examples
  from what comes back.
- Name banks per region and generation, so names come from a list of real ones instead of the model's memory.
- Microdrama trope playbooks (revenge and vindication, hidden identity, contract marriage, second chance) with their
  beat templates, chosen at the pitch.
- A blind voice test: a judge attributes lines to characters with the names hidden; lines it can't attribute get a
  note.
- Retention data from real viewers, to learn which openings and cliffhangers actually hold people.
