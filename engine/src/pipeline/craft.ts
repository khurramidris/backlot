// Worked examples for the writers' room: a weak and a strong version of the same kind of moment, from stories
// unlike the customer's, with the principle that separates them. Rules say what to avoid; examples show what good
// looks like, and less capable models learn far more from the second. Two are shown per scene (an episode's opening
// and ending always get theirs), rotated by a seed so a project doesn't converge on the same pair. The writer is
// told to learn the principle and never copy the content, and the worlds are deliberately varied so none of them
// becomes the default setting.

import { shuffled } from './story.js';

export interface CraftExample { id: string; tags: string[]; teaches: string; weak: string; strong: string; why: string }

export const CRAFT: CraftExample[] = [
  {
    id: 'subtext-one-bowl', tags: ['subtext', 'dialogue'],
    teaches: 'Subtext: nobody names the feeling',
    weak: `MEI: I'm angry that you forgot my birthday again.
JUN: I'm sorry. I feel terrible. Work has been so stressful.`,
    strong: `Mei sets one bowl of noodles on the table. One pair of chopsticks.
JUN: Smells good.
MEI: It's from the place by your office. You'd know.
Jun looks at the single bowl. He glances at his phone, freezes, and turns it face down.`,
    why: 'She punishes him with an object instead of a speech; he understands from the bowl, and his guilt is a phone turned face down. The feeling is played, never stated.',
  },
  {
    id: 'voice-goat', tags: ['voice', 'dialogue'],
    teaches: 'Distinct voices: each person argues in their own currency',
    weak: `TUNDE: I don't think we should do this. It's too risky right now.
MAMA: I agree, it's too risky. We should wait until next month.`,
    strong: `TUNDE: The numbers don't work. Not this month.
MAMA: Numbers. Your father bought this stall with one goat and a promise.
TUNDE: The bank doesn't take goats.
MAMA: Then the bank should eat better.`,
    why: "One speaks in figures, the other in stories, and each answers in their own terms. Cover the names and you still know who is talking; the disagreement is sharper because they don't share a vocabulary.",
  },
  {
    id: 'action-pen', tags: ['action', 'quiet'],
    teaches: 'Action lines: only what a camera can see',
    weak: `Lucía feels nervous and remembers what her father told her. She realizes she has to tell the truth.`,
    strong: `Lucía unscrews the cap of her pen. Screws it back on. Unscrews it.
The inspector stops writing and waits.
She lays the pen down, cap off.`,
    why: 'A state of mind becomes something the hands do, repeated until it means something; the decision is an action (the pen laid down), not a realisation. Nothing the camera cannot see.',
  },
  {
    id: 'opening-ring', tags: ['opening'],
    teaches: 'The opening: start inside an event',
    weak: `A quiet suburban street at dawn. Birds sing. EMMA, 30s, wakes up, stretches and goes downstairs to make coffee.`,
    strong: `Emma's wedding ring rattles down the kitchen drain. She stares into the plughole.
Upstairs, the shower stops. A man's voice calls her name.`,
    why: 'Open in the middle of an event that raises a question in the first second. No waking up, no establishing: the first image is already the story.',
  },
  {
    id: 'ending-phone', tags: ['ending'],
    teaches: 'The ending: a new question, cut before the answer',
    weak: `DANIEL: I can't believe you lied to me all these years. We'll talk about this tomorrow.
He leaves. Rosa sits down, sad.`,
    strong: `The door shuts behind Daniel. Rosa exhales and switches off the lamp.
In the dark, a phone lights up on the sofa. Not hers: his. It buzzes against the cushion.
Rosa looks at it. It buzzes again.`,
    why: 'End on a new question carried by an object and a face, and cut before the answer. The argument is over; the danger has just begun.',
  },
  {
    id: 'turn-leave-form', tags: ['turn', 'dialogue', 'micro'],
    teaches: 'The turn: one piece of information, as late and as short as possible',
    weak: `PRIYA: Can I take Saturday off?
MANAGER: Sure, no problem. Enjoy your weekend.`,
    strong: `The manager signs Priya's leave form without looking up.
MANAGER: Funeral?
PRIYA: Wedding.
MANAGER: Yours?
PRIYA: Yours.
His pen stops.`,
    why: 'The power flips on a single word, and the reaction is a pen that stops, not a speech. A scene in which nothing changes is cut; this one changes everything in five lines.',
  },
  {
    id: 'exposition-chalkboard', tags: ['exposition', 'dialogue'],
    teaches: 'Exposition as ammunition',
    weak: `INÉS: As you know, Dad left us the restaurant when he died three years ago, and you've been running it into the ground ever since.`,
    strong: `Arturo runs a finger along the chalkboard above the counter. It comes away grey with dust.
ARTURO: Dad changed this every morning.
INÉS: Dad also wrote cheques that bounced.
ARTURO: At least people came.`,
    why: 'Backstory surfaces as ammunition in a fight, never as information for the audience. The father, the debt and the decline arrive in three hostile lines and a dusty board.',
  },
  {
    id: 'confrontation-cash', tags: ['confrontation', 'dialogue', 'micro'],
    teaches: 'Heightened, not explained',
    weak: `MRS. OKAFOR: I don't like you, because you are poor and you are not good enough for my son.`,
    strong: `Mrs. Okafor drops a bundle of cash on the table. It slides off and scatters at Ada's feet.
MRS. OKAFOR: For the dress. Return it.
ADA: The wedding is on Saturday.
MRS. OKAFOR: Not yours.
Ada kneels, gathers every note, and squares the stack in front of her.
ADA: Count it. I'd hate you to say I took something.`,
    why: 'The insult is a gesture and four words; the comeback is an action and one line with a blade in it. Big emotion played to the face, and nobody says how they feel.',
  },
  {
    id: 'quiet-two-glasses', tags: ['quiet', 'action'],
    teaches: 'Let a habit carry the emotion',
    weak: `HAMID: I miss her so much. It's so hard being in the shop without her.`,
    strong: `Hamid sets two glasses on the counter, out of habit. He pours tea into one.
His hand hovers over the second. He pours it anyway, and slides it toward the empty stool.`,
    why: 'One gesture, held long enough, says what a speech would flatten. Grief shown as a habit that has lost its reason.',
  },
  {
    id: 'text-message', tags: ['text'],
    teaches: 'Messages the camera cannot show',
    weak: `Her phone screen reads: "YOUR HUSBAND ISN'T AT WORK."`,
    strong: `Her phone buzzes. She reads, and the colour leaves her face.
LENA: (under her breath) Your husband isn't at work.
Across the café, a stranger lowers his phone and lifts his cup to her.`,
    why: 'The video model cannot render legible text, so a message reaches the audience as a voice and a reaction, and a second person turns it into a threat.',
  },
  {
    id: 'rhythm-interrupt', tags: ['confrontation', 'dialogue', 'micro'],
    teaches: 'Pressure: short lines, cut off',
    weak: `KENJI: I was going to tell you about the money, but I was waiting for the right time to explain everything.
AIKO: You should have told me immediately when it happened.`,
    strong: `KENJI: I was going to tell you--
AIKO: When? At the auction?
KENJI: It's not gone, it's--
AIKO: Say "invested" and I walk.`,
    why: 'Under pressure people interrupt and finish each other\'s excuses. Short lines cut off mid-thought make a scene fast, and the one who interrupts holds the power.',
  },
];

/** What a scene card asks for, as example tags. */
export function craftTags(o: { first: boolean; last: boolean; speakers: number; text: string; format: string }): string[] {
  const t = new Set<string>();
  if (o.first) t.add('opening');
  if (o.last) t.add('ending');
  if (o.speakers >= 2) { t.add('dialogue'); t.add('subtext'); t.add('voice'); t.add('turn'); } else t.add('quiet');
  if (/\b(phone|message|text|letter|note|sign|screen|email)\b/i.test(o.text)) t.add('text');
  if (/\b(confront|accuse|threat|humiliat|demand|fight|argue|refuse|slap|expose)/i.test(o.text)) t.add('confrontation');
  if (/\b(past|years ago|inherit|debt|history|used to|always)\b/i.test(o.text)) t.add('exposition');
  if (o.format === 'microdrama') t.add('micro');
  return [...t];
}

const SPECIFIC = ['text', 'confrontation', 'exposition', 'quiet'];

/**
 * Up to `n` examples for a scene: an episode's opening and ending always get theirs, then one that matches a specific
 * need (a message, a confrontation, backstory, a silent scene), then any other match. Rotated by seed, so the same
 * example doesn't teach every scene.
 */
export function craftFor(tags: string[], seed: string, n = 2): CraftExample[] {
  const must = CRAFT.filter((e) => (tags.includes('opening') && e.tags.includes('opening')) || (tags.includes('ending') && e.tags.includes('ending')));
  const fits = (e: CraftExample, among: string[]) => !must.includes(e) && e.tags.some((t) => among.includes(t) && tags.includes(t));
  const specific = shuffled(`${seed}:specific`, CRAFT.filter((e) => fits(e, SPECIFIC)));
  const general = shuffled(seed, CRAFT.filter((e) => fits(e, tags) && !specific.includes(e)));
  return [...must, ...specific.slice(0, 1), ...general, ...specific.slice(1)].slice(0, n);
}
