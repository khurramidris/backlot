// The shapes Claude must answer in (structured outputs). Field descriptions travel with the schema, so
// they double as short instructions right where each value is written. Keep them concrete.
// Numbers and lengths aren't enforceable by the API's schema subset; code checks those.

import { z } from 'zod';

const str = (d: string) => z.string().describe(d);
const list = (d: string) => z.array(z.string()).describe(d);

// ───────────────────────── story development ─────────────────────────

export const DevelopSchema = z.object({
  concepts: z.array(z.object({
    title: str('working title'),
    logline: str('one sentence: who wants what, what stands in the way, what is at stake'),
    engine: str('what drives the story forward scene to scene (a secret, a deadline, a lie that grows, ...)'),
    ending: str('how it ends, in one sentence'),
    fresh_because: str('in one short phrase, what makes this take unlike the obvious version'),
  })).describe('exactly three genuinely different takes on the idea'),
  chosen: z.number().int().describe('index (0, 1 or 2) of the concept developed below'),
  treatment: z.object({
    title: str('final title: short, specific, memorable'),
    logline: str('one sentence'),
    genre: str('genre and sub-genre'),
    tone: str('tone in a few words, e.g. "tense, intimate, darkly funny"'),
    theme: str('what the story is really about, as a statement'),
    dramatic_question: str('the question the audience wants answered'),
    world: z.object({
      place: str('specific city/region and the exact kind of place'),
      era: str('when: year or period'),
      social_world: str('class, community, work, the rules people live by'),
      sensory_palette: list('4 to 6 concrete things this world looks, sounds and feels like'),
    }),
    characters: z.array(z.object({
      id: str('SHORT_ID_IN_CAPS, used as the screenplay character cue'),
      name: str('full name that fits the culture, era and class of the world'),
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
        never_says: str('what this person would never say out loud'),
      }),
      look: str('camera-visible appearance notes that make them instantly distinct from the others: age, build, silhouette, hair, signature colour'),
    })).describe('2 to 4 speaking characters, plus any silent recurring ones'),
    sets: z.array(z.object({
      name: str('PLACE name exactly as it will appear in scene headings, e.g. "RIZVI MEDICAL STORE"'),
      description: str('what the place looks like and what it says about the people in it'),
      story_function: str('why the story needs this place'),
    })).describe('2 to 4 physical places, each reused'),
    episodes: z.array(z.object({
      number: z.number().int(),
      title: str('episode title'),
      beats: z.array(z.object({
        beat: str('what happens, as visible action'),
        set: str('PLACE name from sets'),
        characters: list('character ids in the beat'),
        turn: str('how the situation changes by the end of the beat'),
      })),
      ending: str('the final image or line: payoff for a film, a cliffhanger for a series episode'),
    })),
    motifs: list('1 to 3 recurring visual or sound motifs'),
    avoid: list('the obvious, clichéd choices this premise invites, which the script must not make'),
  }),
});
export type Develop = z.infer<typeof DevelopSchema>;

// ───────────────────────── screenplay ─────────────────────────

export const StyleSchema = z.object({
  look: str('overall mood of the picture'),
  camera: str('lens and movement style'),
  lighting: str('lighting style and motivation'),
  grade: str('colour grade'),
  palette: str('3 to 5 dominant colours of the film, named plainly'),
  texture: str('image texture, e.g. "fine 35mm grain, slight halation on practicals"'),
  negative: str('things to avoid visually, comma separated'),
});

export const ScreenplaySchema = z.object({
  title: str('title'),
  logline: str('one sentence'),
  world: str('place, era and social world in one or two sentences'),
  style: StyleSchema,
  characters: z.array(z.object({
    id: str('SHORT_ID_IN_CAPS, exactly as used for character cues'),
    name: str('full name'),
    age: str('age in years'),
    role: str('lead | supporting'),
    description: str('camera-visible appearance: age, build, face, hair, typical clothing'),
    voice: str('voice casting notes: gender, age, pitch, timbre, pace, accent'),
  })),
  episodes: z.array(z.object({
    title: str('episode title'),
    script: str('the complete Fountain screenplay for this episode'),
  })),
});
export type Screenplay = z.infer<typeof ScreenplaySchema>;

export const DoctorSchema = ScreenplaySchema.extend({
  notes: list('the changes you made, one short line each (at most 8)'),
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
