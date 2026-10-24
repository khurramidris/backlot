// Reference sequences for the shot planner, the WanPE lesson applied cheaply: show the model how strong
// directors cover common dramatic situations, as worked shot plans in our own format, each with the
// principle that makes it work. They teach grammar (why this size, this move, this light, this cut), not
// content: the planner is told never to copy them. Two matching ones are shown per scene, rotated by a
// seed so a whole project doesn't converge on the same two.

import { parseFountain } from './fountain.js';
import { shuffled } from './story.js';

export interface Exemplar { id: string; tags: string[]; situation: string; plan: string; principle: string }

export const EXEMPLARS: Exemplar[] = [
  {
    id: 'confrontation-kitchen', tags: ['confrontation', 'dialogue'],
    situation: 'Two people argue across a kitchen table; one is hiding something.',
    plan: `Shot 1 (8s): 0–4s two-shot, 35mm, static, eye level: she stands at the stove frame left, back half-turned; he sits frame right, hands flat on the table. Tube light hums. 4–8s medium close-up on him, 50mm, slow push-in: he asks his question, eyes never leaving her back.
Shot 2 (7s): 0–3s close-up on her hands, 85mm, static: the spoon stops mid-stir. 3–7s close-up on her face, 85mm, handheld, slight drift: she turns, answers too quickly; a breath she doesn't finish.
Shot 3 (6s): 0–6s over-the-shoulder from behind her onto him, 50mm, static, then a slow tilt down to the envelope under his palm as he slides it forward.`,
    principle: 'Start wide to set the geography (who holds which side), then tighten as the lie surfaces. Cut to hands for the tell. Keep him frame right and her frame left throughout; the camera moves only when the power shifts.',
  },
  {
    id: 'discovery-object', tags: ['reveal', 'suspense'],
    situation: 'Someone finds an object that changes what they believe.',
    plan: `Shot 1 (6s): 0–3s medium, 35mm, static: he searches a drawer, impatient, clattering. 3–6s insert, 100mm macro, static: his fingers touch something wrapped in cloth at the back; the clatter stops.
Shot 2 (8s): 0–4s close-up, 85mm, very slow push-in: his face as he unwraps it, eyes narrowing, no sound but the cloth. 4–8s insert, 100mm, rack focus from the cloth to the object: a woman's wedding ring, engraved, worn thin.
Shot 3 (5s): 0–5s wide, 24mm, static, low angle: he sits back on the floor, small in the frame, the drawer still open above him.`,
    principle: 'Let sound drop out at the moment of discovery. Hold the reaction before showing the object, then show the object in detail. End wide to make him small: the discovery is bigger than he is.',
  },
  {
    id: 'arrival-new-place', tags: ['arrival', 'establish'],
    situation: 'A character arrives somewhere unfamiliar or hostile.',
    plan: `Shot 1 (7s): 0–4s wide, 24mm, static, eye level: the shop at dusk, shutters half down, one fluorescent tube inside; she enters frame from the right and stops. 4–7s medium from behind, 35mm, handheld following her through the doorway.
Shot 2 (6s): 0–3s POV, 35mm, slow pan left to right across the counter: jars, a ledger, a radio murmuring. 3–6s close-up, 85mm, static: her eyes land on the man behind the counter, who has already been watching her.`,
    principle: 'Establish the place once, completely, then move with the character so the audience enters with her. A POV pan builds the space from her eyes; the reveal that someone was already watching turns arrival into threat.',
  },
  {
    id: 'grief-intimate', tags: ['intimate', 'quiet'],
    situation: 'A quiet moment of grief or tenderness between two people.',
    plan: `Shot 1 (9s): 0–9s medium two-shot, 50mm, static, eye level: they sit side by side on the edge of a bed, not touching, soft window light from frame left. After a long beat his hand moves toward hers and stops an inch away.
Shot 2 (6s): 0–6s close-up on her profile, 85mm, static: she notices the hand without looking down, swallows, and very slowly turns her palm up.`,
    principle: 'Stillness and duration do the work: a static frame held longer than comfortable. Soft, single-source light. The whole scene is one small gesture completed across a cut.',
  },
  {
    id: 'suspense-waiting', tags: ['suspense', 'hide'],
    situation: 'A character hides or waits while danger comes closer.',
    plan: `Shot 1 (6s): 0–3s close-up, 85mm, static, low light: her face in a gap between hanging coats, breath held. 3–6s insert from her eyeline, 50mm, static: shoes stop outside the wardrobe door, in the stripe of light under it.
Shot 2 (7s): 0–7s extreme close-up on her eye, 100mm, imperceptible push-in; a floorboard creaks; the stripe of light darkens as someone leans closer.`,
    principle: 'Tighter and tighter frames, with space the audience cannot see. Sound carries the threat: footsteps, a creak, breath. Show the danger only in fragments from the character\'s point of view.',
  },
  {
    id: 'pursuit-movement', tags: ['movement', 'action'],
    situation: 'A character hurries, flees or chases through a space.',
    plan: `Shot 1 (6s): 0–2s wide, 24mm, static: she bursts out of the doorway frame left, running frame right. 2–6s medium, 35mm, handheld tracking alongside her, fast, the wall streaking behind her.
Shot 2 (5s): 0–2s insert, 50mm, static: her foot catches a bucket, water spilling. 2–5s wide, 24mm, static from ahead: she stumbles toward camera, recovers, and glances back over her shoulder.`,
    principle: 'Keep screen direction consistent (always left to right) so the chase reads. Mix static wides with fast handheld tracking. One clear obstacle per shot. The glance back sells the pursuer without showing him.',
  },
  {
    id: 'power-negotiation', tags: ['confrontation', 'power', 'dialogue'],
    situation: 'A negotiation where one person has the power.',
    plan: `Shot 1 (7s): 0–7s wide, 35mm, static, slightly high angle: he sits behind the desk, relaxed; she stands in front of it, bag clutched. The desk lamp lights him; she is half in shadow.
Shot 2 (8s): 0–4s medium close-up on him, 50mm, low angle, static: he names his price, amused. 4–8s close-up on her, 85mm, high angle, static: she absorbs it; then, slowly, she sits down uninvited, and the camera lowers with her to his eye level.`,
    principle: 'Angles carry status: low angle on the powerful, high angle on the weak, eye level when they become equals. Light who is in control. The shift in power is a physical action the camera follows.',
  },
  {
    id: 'phone-one-sided', tags: ['phone'],
    situation: 'A character takes a phone call and hears bad news.',
    plan: `Shot 1 (8s): 0–4s medium, 35mm, static: he answers the phone while chopping onions, casual, phone wedged at his shoulder. 4–8s close-up, 85mm, slow push-in: the knife stops; he takes the phone in his hand; his face empties.
Shot 2 (5s): 0–5s wide, 24mm, static: he stands alone in the small kitchen, phone at his ear, the pot boiling over beside him unnoticed.`,
    principle: 'We only hear his side, so play his behaviour, not the words. Interrupt a routine action. The ignored detail (the pot boiling over) shows how far away his mind has gone.',
  },
  {
    id: 'cliffhanger-ending', tags: ['ending', 'reveal'],
    situation: 'The last moment of an episode: a revelation that demands the next.',
    plan: `Shot 1 (7s): 0–4s medium, 50mm, static: she opens the door expecting the delivery man, smiling. 4–7s close-up, 85mm, fast push-in: the smile drops.
Shot 2 (5s): 0–5s close-up on the visitor, 85mm, static, lit from the hallway behind: the brother everyone thinks is dead, soaked, silent, looking straight at her. Hold. Cut on his first breath before he speaks.`,
    principle: 'End on a face or an object, never on dialogue trailing off. Deny the answer: cut before the explanation. A fast push-in once, at the peak, after a whole episode of restraint.',
  },
  {
    id: 'comic-deflate', tags: ['comic'],
    situation: 'A tense moment punctured by an absurd detail.',
    plan: `Shot 1 (7s): 0–7s two-shot, 35mm, static: the two of them face off in the corridor, dead serious, the argument at its peak.
Shot 2 (4s): 0–4s insert, 50mm, static: a goat wanders calmly between their feet.
Shot 3 (4s): 0–4s two-shot, same framing as shot 1, static: both look down, then at each other; neither will be the first to laugh.`,
    principle: 'Comedy is timing and framing: hold a straight frame, insert the absurd detail without comment, then return to the exact same frame for the reaction. The camera never winks.',
  },
  {
    id: 'dialogue-walk', tags: ['dialogue', 'movement'],
    situation: 'Two people talk while walking or working, not facing each other.',
    plan: `Shot 1 (9s): 0–9s medium two-shot, 35mm, steadicam leading them backwards down a narrow lane: she talks while counting notes into a tin; he answers without looking at her, eyes on the road.
Shot 2 (6s): 0–3s close-up on him, 85mm, tracking alongside: the line that stings. 3–6s close-up on her, 85mm, tracking: she keeps counting and loses the count.`,
    principle: 'Give dialogue a physical task: characters who talk while doing something reveal more than characters who stand and talk. The lost count shows the hit without a word.',
  },
];

/** What kind of dramatic situation a scene is, from its text. Several tags can apply. */
export function sceneTags(body: string, o: { lines: number; first: boolean; last: boolean }): string[] {
  const action = parseFountain(body).filter((e) => e.t === 'action').map((e) => e.text).join(' ').toLowerCase();
  const tags = new Set<string>();
  const has = (rx: RegExp) => rx.test(action);
  if (has(/\b(finds?|found|opens?|discovers?|unfolds?|unwraps?|pulls out|hidden|reveals?)\b/)) tags.add('reveal');
  if (has(/\b(shouts?|slams?|accuses?|grabs?|shoves?|steps closer|refuses?|argues?|glares?|confronts?)\b/) || o.lines >= 6) tags.add('confrontation');
  if (has(/\b(waits?|hides?|hiding|footsteps|creaks?|listens?|peers?|darkness|holds? (her|his) breath)\b/)) tags.add('suspense');
  if (has(/\b(runs?|running|chases?|hurries|rushes|races?|flees?|sprints?|drives?)\b/)) tags.add('movement');
  if (has(/\b(cries|crying|tears|holds|hugs?|embraces?|kiss(es)?|whispers?|touches|strokes?)\b/)) tags.add('intimate');
  if (has(/\b(phone|calls?|dials?|answers? the)\b/)) tags.add('phone');
  if (has(/\b(laughs?|grins?|jokes?|snorts?|giggles?)\b/)) tags.add('comic');
  if (has(/\b(enters?|arrives?|steps (in|out|inside)|walks in)\b/) || o.first) tags.add('arrival');
  if (o.last) tags.add('ending');
  if (o.lines >= 2) tags.add('dialogue');
  if (!tags.size) tags.add('quiet');
  return [...tags];
}

/** Up to `n` exemplars matching the scene, rotated by seed; the last scene of an episode always gets the cliffhanger lesson. */
export function exemplarsFor(tags: string[], seed: string, n = 2): Exemplar[] {
  const scored = shuffled(seed, EXEMPLARS)
    .map((e) => ({ e, score: e.tags.filter((t) => tags.includes(t)).length + (tags.includes('ending') && e.tags.includes('ending') ? 5 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out = scored.slice(0, n).map((x) => x.e);
  for (const e of shuffled(seed + ':fill', EXEMPLARS)) if (out.length < n && !out.includes(e)) out.push(e);
  return out;
}
