import type { ActorDto } from "@repo/core/contracts";

/** An actor's display name, marked when deactivated. */
export const actorLabel = (actor: ActorDto) =>
  actor.deactivated ? `${actor.name} (deactivated)` : actor.name;

/** A person's name for display; "(deactivated)" when they left, `fallback` when not loaded. */
export const nameOf = (actor: ActorDto | undefined, fallback: string) =>
  actor ? actorLabel(actor) : fallback;

/** "@handle" for activity text, marked when deactivated. */
export const mentionOf = (actor: ActorDto | undefined) =>
  actor
    ? `@${actor.handle}${actor.deactivated ? " (deactivated)" : ""}`
    : "@unknown";

/** A task's assignees in order; unknown ids (not loaded yet) are skipped. */
export function assigneesOf(
  ids: string[],
  actors: Map<string, ActorDto>,
): ActorDto[] {
  return ids.map((id) => actors.get(id)).filter((a): a is ActorDto => !!a);
}

/**
 * What the assignee picker shows: the selected actors, deactivated ones included, and the
 * options — active members plus deactivated assignees, so those can be removed but no one
 * can newly assign a deactivated actor.
 */
export function assigneeOptions(
  members: ActorDto[],
  actors: ActorDto[],
  value: string[],
) {
  const byId = new Map([...actors, ...members].map((a) => [a.id, a]));
  const selected = assigneesOf(value, byId);
  const active = new Set(members.map((m) => m.id));
  const options = [...members, ...selected.filter((a) => !active.has(a.id))];
  return { selected, options };
}

/** Toggles an assignee; a deactivated actor can only be removed. */
export function toggleAssignee(value: string[], actor: ActorDto): string[] {
  if (value.includes(actor.id)) return value.filter((v) => v !== actor.id);
  return actor.deactivated ? value : [...value, actor.id];
}
