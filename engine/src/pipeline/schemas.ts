// The shapes Claude must answer in (structured outputs). Field descriptions travel with the schema, so
// they double as short instructions right where each value is written. Keep them concrete.
// Numbers and lengths aren't enforceable by the API's schema subset; code checks those.

import { z } from 'zod';

const str = (d: string) => z.string().describe(d);
const list = (d: string) => z.array(z.string()).describe(d);

// ───────────────────────── the writers' room ─────────────────────────
// One small job per call, each answer a production document the next step builds on (never a reasoning field).

const score = (d: string) => z.number().int().describe(`${d}: 1 (weak) to 5 (excellent)`);

export const PitchSchema = z.object({
  concepts: z.array(z.object({
    title: str('working title'),
    protagonist: str('who we follow: name, age, what they do'),
    logline: str('one sentence: who wants what, who or what stands in the way, what is at stake'),
    world: str('the specific place, community and time, in a phrase'),
    engine: str('what drives the story from scene to scene (a secret, a deadline, a lie that grows, ...)'),
    hook: str('the first three seconds: what we see and hear that stops a viewer scrolling'),
    turn: str('the biggest reversal or reveal, and when it lands'),
    ending: str('the final image or line'),
    fresh_because: str('in one short phrase, what makes this take unlike the obvious version'),
  })).describe('exactly three genuinely different takes on the idea'),
});

export const ChooseSchema = z.object({
  scores: z.array(z.object({
    concept: z.number().int().describe('index of the take: 0, 1 or 2'),
    fidelity: score('keeps everything the customer asked for'),
    hook: score('the opening stops a viewer scrolling'),
    stakes: score('someone wants something concrete and failing costs them personally'),
    specificity: score('the world, people and details are specific, not generic'),
    surprise: score('the turn is unexpected, yet inevitable in hindsight'),
    renderable: score('works with 2 to 4 people in 2 to 4 places, everything visible or audible'),
  })).describe('one entry per take'),
  chosen: z.number().int().describe('index of the take to develop'),
  notes: list('2 or 3 concrete notes that would make the chosen take stronger in development'),
});

export const StyleSchema = z.object({
  look: str('overall mood of the picture'),
  camera: str('lens and movement style'),
  lighting: str('lighting style and motivation'),
  grade: str('colour grade'),
  palette: str('3 to 5 dominant colours of the film, named plainly'),
  texture: str('image texture, e.g. "fine 35mm grain, slight halation on practicals"'),
  negative: str('things to avoid visually, comma separated'),
});

export const BibleSchema = z.object({
  title: str('final title: short, specific, memorable'),
  logline: str('one sentence'),
  genre: str('genre and sub-genre'),
  tone: str('tone in a few words, e.g. "tense, intimate, darkly funny"'),
  theme: str('what the story is really about, as a statement'),
  dramatic_question: str('the question the audience wants answered'),
  world: z.object({
    place: str('specific city or region and the exact kind of place'),
    era: str('when: year or period'),
    social_world: str('class, community, work, the rules people live by'),
    sensory_palette: list('4 to 6 concrete things this world looks, sounds and feels like'),
  }),
  characters: z.array(z.object({
    id: str('SHORT_ID in capital letters (A to Z), usually the first name: the screenplay cue'),
    name: str('full name that people of this place, generation and class are really called'),
    age: str('age in years'),
    role: str('lead | supporting'),
    want: str('what they actively pursue in this story'),
    obstacle: str('what or who stands in the way'),
    secret: str('what they hide or will not admit'),
    arc: str('how they change, or refuse to'),
    voice: z.object({
      manner: str('how they talk: e.g. clipped and dry, warm and roundabout'),
      vocabulary: str('the words they reach for: trade slang, formal, street, religious, ...'),
      rhythm: str('sentence length and pace'),
      habit: str('one verbal habit, e.g. answers a question with a question, counts things, never finishes a threat'),
      never_says: str('what this person would never say out loud'),
      sample_lines: list('two short lines in the dialogue language that only this character would say'),
    }),
    look: str('camera-visible appearance notes that make them instantly distinct from the others: age, build, silhouette, hair, signature colour'),
  })).describe('2 to 4 speaking characters, plus any silent recurring ones'),
  relationships: z.array(z.object({
    between: str('two character ids, e.g. "A & B"'),
    dynamic: str('what binds them and what pulls them apart, in one sentence'),
  })),
  sets: z.array(z.object({
    name: str('PLACE name in capitals, exactly as scene headings will use it: a specific place in this story'),
    description: str('what the place looks like and what it says about the people in it'),
    story_function: str('why the story needs this place'),
  })).describe('2 to 4 physical places, each reused'),
  plants: z.array(z.object({
    id: str('P1, P2, ...'),
    setup: str('what is planted on screen early: an object, a habit, a line'),
    payoff: str('how it pays off later'),
  })).describe('the setups the ending and the reveals depend on'),
  episodes: z.array(z.object({
    number: z.number().int(),
    title: str('episode title'),
    summary: str('what happens, in two or three sentences'),
    opening: str('the first three seconds of the episode: what we see and hear'),
    ending: str('the final image or line: a payoff for a film, a cliffhanger for a series episode'),
  })),
  motifs: list('1 to 3 recurring visual or sound motifs'),
  avoid: list('the obvious, clichéd choices this premise invites, which the script must not make'),
  style: StyleSchema.describe("the film's look, specific to this world and tone, not a generic cinematic look"),
});
export type Bible = z.infer<typeof BibleSchema>;

export const RenameSchema = z.object({
  names: z.array(z.object({ id: str('the character id'), name: str('the new full name') })),
});

export const OutlineSchema = z.object({
  scenes: z.array(z.object({
    set: str("PLACE name from the bible's sets, exactly"),
    int_ext: z.enum(['INT', 'EXT']),
    time: z.enum(['DAY', 'NIGHT', 'DAWN', 'DUSK']),
    characters: list('ids of the characters on screen'),
    seconds: z.number().int().describe('screen time in seconds'),
    purpose: str('what the scene does for the story, in a few words'),
    objectives: z.array(z.object({
      who: str('character id'),
      wants: str('what they want in this scene'),
      tactic: str('how they go about it, as a verb: charm, stall, bait, threaten, bargain, deflect, confess, ...'),
    })).describe('one per character on screen'),
    subtext: str('what is really going on beneath the words'),
    turn: str('what changes by the end of the scene: who gains or loses what'),
    value: str('the emotional value at the start and at the end, e.g. "safe → exposed"'),
    key_image: str('the one image the audience must remember'),
    exit: str('the last moment, an image or a short line, that pulls us into the next scene'),
    plants: list('ids of the plants this scene sets up'),
    payoffs: list('ids of the plants this scene pays off'),
  })).describe('the scenes of this episode, in order'),
});
export type Card = z.infer<typeof OutlineSchema>['scenes'][number];

export const SceneSchema = z.object({
  elements: z.array(z.object({
    kind: z.enum(['action', 'line']),
    who: str("a line: the speaker's character id; action: empty"),
    paren: str('a line: a delivery note of 2 to 5 words, only when it changes how the line plays; usually empty'),
    text: str('action: what the camera sees and the microphone hears, in English, one or two sentences; line: the spoken words, in the dialogue language'),
  })).describe('the scene from its first moment to its last, in order'),
});
export type Element = z.infer<typeof SceneSchema>['elements'][number];

export const CritiqueSchema = z.object({
  scores: z.object({
    hook: score('the first seconds grab'),
    turns: score('every scene turns'),
    escalation: score('the pressure rises to the end'),
    dialogue: score('subtext and distinct voices, no stock or on-the-nose lines'),
    specificity: score('specific, never generic'),
    ending: score('the ending lands'),
    fidelity: score("it delivers the customer's idea"),
  }),
  scenes: z.array(z.object({
    episode: z.number().int(),
    scene: z.number().int(),
    verdict: z.enum(['keep', 'revise']),
    notes: z.array(z.object({
      problem: str('quote the weak moment and name what is wrong'),
      fix: str('the concrete change to make'),
    })).describe('empty when the verdict is keep'),
  })).describe('every scene of the screenplay, in order'),
});

export const JudgeSchema = z.object({
  verdicts: z.array(z.object({
    pair: z.number().int().describe('pair number'),
    better: z.enum(['A', 'B']),
    margin: z.enum(['clear', 'slight']),
  })).describe('one verdict per pair'),
});

// ───────────────────────── breakdown ─────────────────────────

const scenes = list('scene refs, e.g. ["E1S2", "E1S4"]');
export const BreakdownSchema = z.object({
  style: StyleSchema,
  characters: z.array(z.object({
    key: str('UPPER_CASE id from the bible, or a new one for an unlisted recurring character'),
    name: z.string(),
    is_minor: z.boolean(),
    description: str('visual identity lock (35 to 70 words)'),
    looks: z.array(z.object({
      key: str('DEFAULT or a short UPPER_SNAKE name'),
      name: z.string(),
      wardrobe: str('specific garments, colours, fabrics, fit, condition, shoes, accessories'),
      scenes,
    })),
    voice: z.object({ brief: str('voice-casting brief'), sample_line: str('an original 12 to 25 word line in character') }),
    scenes,
  })),
  sets: z.array(z.object({
    key: str('UPPER_SNAKE'),
    name: z.string(),
    building: str('UPPER_SNAKE shared by rooms of the same building, or empty'),
    int_ext: str('INT | EXT | INT/EXT'),
    description: str('visual lock (40 to 90 words)'),
    layout: str('where things are, so reverse angles stay consistent'),
    variants: z.array(z.object({ key: str('UPPER_SNAKE, e.g. NIGHT'), name: z.string(), change: str('what looks different'), scenes })),
    scenes,
  })),
  props: z.array(z.object({ key: str('UPPER_SNAKE'), name: z.string(), description: str('material, colour, size, markings, wear'), owner: str('CHARACTER key or empty'), scenes })),
});

// ───────────────────────── direction and shots ─────────────────────────

export const DirectionSchema = z.object({
  visual_approach: str('the camera and lighting language of this episode, and how it evolves as tension rises'),
  motifs: list('visual or sound motifs and where they recur'),
  scenes: z.array(z.object({
    scene: z.number().int().describe('scene number'),
    purpose: str('what this scene does for the story'),
    temperature: z.number().int().describe('emotional intensity from 1 (calm) to 10 (peak)'),
    pace: z.enum(['slow', 'measured', 'fast']),
    key_image: str('the one image that must land in this scene'),
    camera: str('how the camera behaves in this scene, and why'),
    light: str('light sources, direction, quality and colour in this scene'),
    blocking: str('where people start, where they move, who holds which side of frame'),
    opening_image: str('the first image of the scene'),
    closing_image: str('the last image of the scene, cutting into the next'),
    shots: z.number().int().describe('how many generation shots (4 to 15 s each) this scene deserves'),
  })),
});
export type Direction = z.infer<typeof DirectionSchema>;

const BeatSchema = z.object({
  t0: z.number(), t1: z.number(),
  shot: str('wide | full | medium | medium close-up | close-up | extreme close-up | over-the-shoulder | two-shot | insert | POV'),
  angle: str('eye level | low | high | overhead | dutch | profile | ...'),
  lens: str('lens feel: "wide 24mm", "normal 35mm", "portrait 85mm", "long 135mm compression"'),
  camera: str('movement as start → end framing, e.g. "slow push-in from waist to eyes", "static", "handheld drift following her to the door"'),
  action: str('what we see happen, in visible, physical terms'),
  blocking: str('where each person is and moves in frame; empty if unchanged'),
  performance: str('the precise visible behaviour: breath, eyes, hands, stillness'),
  light: str('light on this beat if it differs from the scene: source, direction, colour; else empty'),
  dialogue: z.array(z.object({ who: str('CHARACTER key'), line: str('verbatim from the script'), delivery: str('how it is said, visibly and audibly') })),
});

export const ShotsSchema = z.object({
  screen_positions: str('where each character stands in frame for this scene, kept consistent'),
  shots: z.array(z.object({
    duration: z.number().int().describe('4 to 15 seconds'),
    purpose: str('what this shot does for the story, in a few words'),
    covers: z.array(z.number().int()).describe('numbers of the ACTION lines this shot shows'),
    characters: list('character keys on screen'),
    props: list('prop keys visible'),
    beats: z.array(BeatSchema),
    sound: str('specific diegetic sound for the shot'),
  })),
});

export const RetakeSchema = z.object({
  duration: z.number().int(),
  purpose: z.string(),
  characters: z.array(z.string()),
  props: z.array(z.string()),
  beats: z.array(BeatSchema),
  sound: z.string(),
});
