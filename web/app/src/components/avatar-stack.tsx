import { ActorAvatar } from "@/components/task-fields";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { splitStack } from "@/lib/avatar-stack";
import { actorLabel } from "@/lib/assignees";
import { cn } from "@/lib/utils";
import type { ActorDto } from "@repo/core/contracts";

/**
 * Overlapping avatars (people and agents) with a "+N" chip past `max` and a tooltip listing every name.
 * `highlight` may return extra classes for one avatar (e.g. a ring for "working now").
 */
export function AvatarStack({
  actors,
  max = 3,
  className,
  avatarClassName = "size-5",
  ringClassName = "ring-background",
  highlight,
}: {
  actors: ActorDto[];
  max?: number;
  className?: string;
  avatarClassName?: string;
  /** Colour of the separating ring, e.g. `ring-card` on cards. */
  ringClassName?: string;
  highlight?: (actor: ActorDto) => string | undefined;
}) {
  if (actors.length === 0) return null;
  const { visible, overflow } = splitStack(actors, max);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("flex shrink-0 -space-x-2", className)}>
          {visible.map((a) => (
            <ActorAvatar
              key={a.id}
              actor={a}
              title={false}
              className={cn(
                avatarClassName,
                "ring-2",
                ringClassName,
                highlight?.(a),
              )}
            />
          ))}
          {overflow > 0 && (
            <span
              className={cn(
                "relative flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2",
                avatarClassName,
                ringClassName,
              )}
            >
              +{overflow}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <ul>
          {actors.map((a) => (
            <li key={a.id}>{actorLabel(a)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
