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
 * `highlight` may return extra classes for one avatar (e.g. a ring for "working now"); `isWorking`
 * marks agents working on the task right now with a pulsing dot and "working now" in the tooltip.
 * The stack is keyboard-focusable (it names everyone in its label) unless `interactive={false}`,
 * for stacks inside another button or link.
 */
export function AvatarStack({
  actors,
  max = 3,
  className,
  avatarClassName = "size-5",
  ringClassName = "ring-background",
  highlight,
  isWorking,
  interactive = true,
}: {
  actors: ActorDto[];
  max?: number;
  className?: string;
  avatarClassName?: string;
  /** Colour of the separating ring, e.g. `ring-card` on cards. */
  ringClassName?: string;
  highlight?: (actor: ActorDto) => string | undefined;
  isWorking?: (actor: ActorDto) => boolean;
  interactive?: boolean;
}) {
  if (actors.length === 0) return null;
  const { visible, overflow } = splitStack(actors, max);
  const label = (a: ActorDto) => (isWorking?.(a) ? `${actorLabel(a)}, working now` : actorLabel(a));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="group"
          tabIndex={interactive ? 0 : undefined}
          aria-label={actors.map(label).join(", ")}
          className={cn(
            "flex shrink-0 -space-x-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {visible.map((a) => (
            <span key={a.id} className="relative flex shrink-0">
              <ActorAvatar
                actor={a}
                title={false}
                className={cn(
                  avatarClassName,
                  "ring-2",
                  ringClassName,
                  highlight?.(a),
                )}
              />
              {isWorking?.(a) && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background motion-safe:animate-pulse"
                />
              )}
            </span>
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
            <li key={a.id}>{label(a)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
