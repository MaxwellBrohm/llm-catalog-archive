/**
 * Which candidates are worth interrupting someone for, right now.
 *
 * THE DESK IS A DIGEST AND THAT IS USUALLY RIGHT. One mail a morning suits a
 * price change or a doc move, which keep. It is wrong for exactly one kind of
 * item, and the cost was measured rather than guessed: the first stealth
 * listing this archive ever recorded was captured on 2026-09-16 at 15:06 UTC,
 * EIGHTEEN MINUTES before the first person posted it to Hacker News, and the
 * desk showed it twenty-one hours later. The collection layer was ahead of the
 * world and the distribution layer gave the lead away.
 *
 * So the digest keeps its shape and a second, rarer path runs beside it: a
 * candidate far enough above the floor gets mailed as soon as it is seen.
 *
 * NOTHING HERE POSTS ANYTHING. It decides whether to wake someone up. Every
 * rule about a person pressing the last button is untouched.
 */

import type { Candidate } from './queue.js';

/**
 * The interrupt floor, in bits.
 *
 * EIGHT, and the number is a rate rather than a feeling. Scored over the live
 * archive the types that clear it are stealth listings and first-of-their-kind
 * events, which have arrived roughly once or twice a week: 10.11 for
 * stealth/union-alpha, 8.32 for stealth/space-bunny-alpha, against 5.9 and 4.8
 * for the status-page incidents that make up most days. A floor low enough to
 * fire daily would turn an interrupt into a second digest, and the second
 * digest is the one that gets filtered to a folder.
 */
export const ALERT_FLOOR_BITS = 8;

/** What the routine has already woken someone up about. */
export type AlertState = { readonly alerted: readonly string[] };

export function parseAlertState(text: string): AlertState {
  const raw: unknown = JSON.parse(text);
  const list = (raw as { alerted?: unknown })?.alerted;
  return { alerted: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [] };
}

/**
 * Candidates worth an immediate mail: above the floor, and not already sent.
 *
 * KEYED ON THE ITEM ID, WHICH CARRIES THE SHA, so the same story recaptured
 * under a new commit is a new id and would alert twice. That is deliberate and
 * it is the safer direction: an item whose bytes changed again really is new
 * information, and the cooldown in the queue already suppresses a subject
 * that has been POSTED. Alerting twice about a developing story costs a
 * notification; staying silent about a second development costs the story.
 */
export function alertable(
  candidates: readonly Candidate[],
  state: AlertState,
  floorBits: number = ALERT_FLOOR_BITS,
): Candidate[] {
  const sent = new Set(state.alerted);
  return candidates.filter((c) => c.score.bits >= floorBits && !sent.has(c.item.id));
}

/**
 * The state to write back after alerting.
 *
 * BOUNDED, because this file is force-pushed to a branch every two hours and an
 * unbounded list would grow for ever. The cap is well above the rate: at one or
 * two alerts a week, 500 ids is years of history, and the only thing forgetting
 * an ancient id can cause is one duplicate mail about a story old enough that
 * the staleness penalty has long since pushed it under the floor anyway.
 */
export const ALERT_MEMORY = 500;

export function nextAlertState(state: AlertState, justSent: readonly Candidate[]): AlertState {
  const ids = [...state.alerted, ...justSent.map((c) => c.item.id)];
  return { alerted: ids.slice(-ALERT_MEMORY) };
}
