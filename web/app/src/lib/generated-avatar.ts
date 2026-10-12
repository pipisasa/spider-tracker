import { botttsNeutral, notionistsNeutral } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import type { ActorDto } from "@repo/core/contracts";

// Only these two styles are imported, so the rest of the DiceBear collection is tree-shaken.
export type GeneratedAvatarKind = "human" | "agent";

const cache = new Map<string, string>();

/** A deterministic generated avatar (SVG data URI) for a seed, memoised per (kind, seed, size). */
export function generatedAvatarUri(
  kind: GeneratedAvatarKind,
  seed: string,
  size = 64,
): string {
  const key = `${kind}:${size}:${seed}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = (
      kind === "agent"
        ? createAvatar(botttsNeutral, { seed, size })
        : createAvatar(notionistsNeutral, { seed, size })
    ).toDataUri();
    cache.set(key, uri);
  }
  return uri;
}

/** The avatar an actor shows: their own image, else one generated from the stable actor id. */
export function actorAvatarSrc(
  actor: Pick<ActorDto, "id" | "type" | "avatarUrl">,
): string {
  return (
    actor.avatarUrl ||
    generatedAvatarUri(actor.type === "agent" ? "agent" : "human", actor.id)
  );
}
